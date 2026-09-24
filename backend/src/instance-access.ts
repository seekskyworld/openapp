import type { ProvisioningPolicy } from "./instance-policy.js";
import type { Container } from "./models.js";
import { InstanceLifecycleError } from "./instance-lifecycle.js";

export type InstanceAccessIntent = "proxy" | "enter";

export interface InstanceAccessOperationOptions {
  /** 调用方已经持有实例维护租约时透传给生命周期层，避免重复认领同名租约。 */
  maintenanceLeaseHeld?: boolean;
  /** 维护租约失效时中止后续 Runtime 和健康探针操作。 */
  signal?: AbortSignal;
}

interface InstanceAccessLifecycle {
  /** Read the persisted/runtime snapshot without claiming a maintenance lease. */
  read(id: string, options?: InstanceAccessOperationOptions): Promise<Container>;
  sync(id: string, options?: InstanceAccessOperationOptions): Promise<Container>;
  start(id: string, options?: InstanceAccessOperationOptions): Promise<Container>;
  stop(id: string, reason: "failure", options?: InstanceAccessOperationOptions): Promise<Container>;
}

type ReadyContainer = Container;

export interface InstanceAccessOptions {
  lifecycle: InstanceAccessLifecycle;
  getPolicy(): Promise<ProvisioningPolicy>;
  touch(id: string): Promise<void>;
  probe(endpoint: string, signal: AbortSignal): Promise<boolean>;
  /** 新访问平面按需解析私有目标；未提供时只用于旧 endpoint 回切。 */
  probeCurrent?(container: Container, signal: AbortSignal): Promise<boolean>;
  wakeTimeoutMs?: number;
  retryIntervalMs?: number;
  observationTtlMs?: number;
}

export class InstanceAccessError extends Error {
  constructor(
    readonly code: "instance_wake_disabled" | "instance_manually_stopped" | "instance_start_failed" | "instance_wake_timeout" | "container_not_running",
    readonly status = 503,
  ) {
    super(code);
  }
}

/** Coordinates proxy readiness without making every request a lifecycle write. */
export class WorkspaceAccessCoordinator {
  readonly #lifecycle: InstanceAccessLifecycle;
  readonly #getPolicy: () => Promise<ProvisioningPolicy>;
  readonly #touch: (id: string) => Promise<void>;
  readonly #probe: (endpoint: string, signal: AbortSignal) => Promise<boolean>;
  readonly #probeCurrent: ((container: Container, signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly #wakeTimeoutMs: number;
  readonly #retryIntervalMs: number;
  readonly #observationTtlMs: number;
  readonly #wakes = new Map<string, Promise<Container>>();
  readonly #proxyReadiness = new Map<string, Promise<ReadyContainer>>();
  readonly #readyObservations = new Map<string, { expiresAt: number; container: ReadyContainer }>();

  constructor(options: InstanceAccessOptions) {
    this.#lifecycle = options.lifecycle;
    this.#getPolicy = options.getPolicy;
    this.#touch = options.touch;
    this.#probe = options.probe;
    this.#probeCurrent = options.probeCurrent;
    this.#wakeTimeoutMs = options.wakeTimeoutMs ?? 45_000;
    this.#retryIntervalMs = options.retryIntervalMs ?? 250;
    this.#observationTtlMs = options.observationTtlMs ?? 250;
  }

  async acquire(
    id: string,
    intent: InstanceAccessIntent,
    options: InstanceAccessOperationOptions = {},
  ): Promise<ReadyContainer> {
    options.signal?.throwIfAborted();
    await this.#touch(id);
    options.signal?.throwIfAborted();
    // 浏览器会并发请求 HTML、JS 和 CSS。普通代理访问必须共享完整的就绪
    // 流程，否则后续资源会在首个请求启动容器时争抢同一维护租约并收到 409。
    if (intent === "proxy" && options.maintenanceLeaseHeld !== true) {
      return this.#proxyReady(id, options);
    }
    return this.#acquireReady(id, intent, options);
  }

  #proxyReady(id: string, options: InstanceAccessOperationOptions): Promise<ReadyContainer> {
    options.signal?.throwIfAborted();
    const cached = this.#readyObservations.get(id);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.container);
    if (cached) this.#readyObservations.delete(id);
    const existing = this.#proxyReadiness.get(id);
    if (existing) return this.#waitForShared(existing, options.signal);
    // Shared readiness belongs to the instance, not to the first browser
    // request. One cancelled navigation must not abort every asset/API waiter.
    const readiness = this.#acquireReady(id, "proxy", {}).then((container) => {
      this.#readyObservations.set(id, {
        expiresAt: Date.now() + this.#observationTtlMs,
        container,
      });
      return container;
    }).finally(() => {
      if (this.#proxyReadiness.get(id) === readiness) this.#proxyReadiness.delete(id);
    });
    this.#proxyReadiness.set(id, readiness);
    return this.#waitForShared(readiness, options.signal);
  }

  #waitForShared<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return operation;
    signal.throwIfAborted();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        cleanup();
        reject(signal.reason instanceof Error ? signal.reason : new Error("request_aborted"));
      };
      const cleanup = () => signal.removeEventListener("abort", abort);
      signal.addEventListener("abort", abort, { once: true });
      operation.then(
        (value) => { cleanup(); resolve(value); },
        (error: unknown) => { cleanup(); reject(error); },
      );
    });
  }

  async #acquireReady(
    id: string,
    intent: InstanceAccessIntent,
    options: InstanceAccessOperationOptions,
  ): Promise<ReadyContainer> {
    let current = await this.#readForAccess(id, options);
    // A failed record may be the durable footprint of an interrupted rebuild.
    // Give Runtime one recovery-aware sync before rejecting access; genuine
    // failures remain failed because lifecycle preserves that state unless
    // Runtime explicitly reports a rebuild recovery.
    if (current.status === "failed") current = await this.#lifecycle.sync(id, options);
    if (current.status === "running" && this.#hasProbeTarget(current)) {
      return intent === "enter"
        ? this.#waitForHealthy(id, current, options)
        : current;
    }
    if (current.status === "failed") throw new InstanceAccessError("instance_start_failed");
    if (current.status !== "stopped") throw new InstanceAccessError("container_not_running", 409);

    const policy = await this.#getPolicy();
    if (intent === "enter" && !policy.autoStartOnEnter) {
      throw new InstanceAccessError("instance_wake_disabled", 409);
    }
    if (intent === "proxy") this.#assertProxyWakeAllowed(current, policy);
    // 已持有分布式租约的显式 enter 不能复用未持租约的 proxy wake；否则
    // enter 会在租约内等待一个仍需认领同名租约的 Promise。
    const ready = options.maintenanceLeaseHeld
      ? await this.#startAndWait(id, options, false)
      : intent === "proxy"
        ? await this.#wake(id, options, true)
        : await this.#startAndWait(id, options, false);
    options.signal?.throwIfAborted();
    await this.#touch(id);
    return ready;
  }

  async #readForAccess(id: string, options: InstanceAccessOperationOptions): Promise<Container> {
    return this.#lifecycle.read(id, options);
  }

  #assertProxyWakeAllowed(container: Container, policy: ProvisioningPolicy): void {
    if (!policy.autoWakeOnRequest) throw new InstanceAccessError("instance_wake_disabled", 409);
    if (container.stopReason === "failure") throw new InstanceAccessError("instance_start_failed");
    if (
      policy.blockAutoWakeAfterManualStop
      && (container.stopReason === "manual_user" || container.stopReason === "manual_admin")
    ) {
      throw new InstanceAccessError("instance_manually_stopped", 409);
    }
  }

  #wake(id: string, options: InstanceAccessOperationOptions, waitForMaintenance: boolean): Promise<Container> {
    const existing = this.#wakes.get(id);
    if (existing) return existing;
    const wake = this.#startAndWait(id, options, waitForMaintenance).finally(() => {
      if (this.#wakes.get(id) === wake) this.#wakes.delete(id);
    });
    this.#wakes.set(id, wake);
    return wake;
  }

  async #startAndWait(id: string, options: InstanceAccessOperationOptions, waitForMaintenance: boolean): Promise<Container> {
    const deadline = Date.now() + this.#wakeTimeoutMs;
    const started = await this.#startOrJoin(id, options, deadline, waitForMaintenance);
    if (started.status !== "running" || !this.#hasProbeTarget(started)) {
      throw new InstanceAccessError("instance_start_failed");
    }
    return this.#waitForHealthy(id, started, options, deadline);
  }

  async #waitForHealthy(
    id: string,
    started: ReadyContainer,
    options: InstanceAccessOperationOptions,
    deadline = Date.now() + this.#wakeTimeoutMs,
  ): Promise<ReadyContainer> {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      try {
        const timeoutSignal = AbortSignal.timeout(Math.min(1_500, this.#wakeTimeoutMs));
        const probeSignal = options.signal
          ? AbortSignal.any([options.signal, timeoutSignal])
          : timeoutSignal;
        const healthy = this.#probeCurrent
          ? await this.#probeCurrent(started, probeSignal)
          : await this.#probe(started.endpoint!, probeSignal);
        if (healthy) {
          return started;
        }
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (error instanceof InstanceAccessError) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, this.#retryIntervalMs));
    }
    options.signal?.throwIfAborted();
    try {
      await this.#lifecycle.stop(id, "failure", options);
    } catch {
      // 即使 Runtime 清理失败，也必须保留唤醒超时作为主错误。
    }
    throw new InstanceAccessError("instance_wake_timeout");
  }

  async #startOrJoin(
    id: string,
    options: InstanceAccessOperationOptions,
    deadline: number,
    waitForMaintenance: boolean,
  ): Promise<Container> {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      try {
        return await this.#lifecycle.start(id, options);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (!(error instanceof InstanceLifecycleError) || error.code !== "container_maintenance_busy") {
          if (error instanceof InstanceAccessError || error instanceof InstanceLifecycleError) throw error;
          throw new InstanceAccessError("instance_start_failed");
        }
        if (!waitForMaintenance) throw error;
        await this.#pauseUntilRetry(deadline);
        const current = await this.#lifecycle.read(id, options);
        if (current.status === "running" && this.#hasProbeTarget(current)) return current;
        if (current.status === "failed") throw new InstanceAccessError("instance_start_failed");
      }
    }
    throw new InstanceAccessError("instance_wake_timeout");
  }

  async #pauseUntilRetry(deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(this.#retryIntervalMs, remaining)));
  }

  #hasProbeTarget(container: Container): boolean {
    return Boolean(this.#probeCurrent || container.endpoint);
  }
}

/** 兼容旧调用方；新组合根统一使用 WorkspaceAccessCoordinator。 */
export class InstanceRuntimeCoordinator extends WorkspaceAccessCoordinator {}

/** 兼容更早的访问协调器名称。 */
export class InstanceAccessCoordinator extends WorkspaceAccessCoordinator {}
