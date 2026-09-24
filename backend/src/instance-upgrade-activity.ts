import { randomUUID } from "node:crypto";

import type { Container } from "./models.js";
import type { ContainerActivityMetrics } from "./runtime.js";
import type { ProviderMetricsPort } from "./execution-provider.js";
import { readProviderMetrics } from "./provider-observability.js";
import type { UpgradeActivityAssessment, UpgradeRolloutItem } from "./upgrade-rollouts.js";

export type InstanceActivityKind = "http" | "websocket";

export interface InstanceActivityLease {
  id: string;
  instanceId: string;
  kind: InstanceActivityKind;
  openedAt: string;
  heartbeatAt: string;
  lastActivityAt: string;
}

export interface InstanceActivityStore {
  tryOpenLease(lease: InstanceActivityLease, at: string): Promise<boolean>;
  renewLease(lease: InstanceActivityLease, at: string): Promise<boolean>;
  deleteLease(id: string): Promise<void>;
  closeLease(id: string, instanceId: string, closedAt: string): Promise<void>;
  listActiveLeases(instanceId: string, heartbeatCutoff: string): Promise<InstanceActivityLease[]>;
}

export type InstanceDrainMode = "graceful" | "force";

export interface InstanceDrainRequest {
  instanceId: string;
  rolloutId: string;
  attemptId: string;
  at: string;
  expiresAt: string;
  heartbeatCutoff: string;
  websocketActivityCutoff: string;
  mode: InstanceDrainMode;
}

export interface InstanceUpgradeAdmissionStore {
  beginInstanceDraining(request: InstanceDrainRequest): Promise<boolean>;
  clearInstanceDraining(instanceId: string, rolloutId: string, attemptId: string): Promise<void>;
  isInstanceDraining(instanceId: string, at: string): Promise<boolean>;
}

export interface InstanceActivityHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  heartbeat(): Promise<void>;
  touch(): Promise<void>;
  close(): Promise<void>;
}

/** 代理层与升级领域之间的最小活动监控接口。 */
export interface InstanceActivityMonitor {
  open(instanceId: string, kind: InstanceActivityKind): Promise<InstanceActivityHandle>;
  run<T>(
    instanceId: string,
    kind: InstanceActivityKind,
    operation: (handle: InstanceActivityHandle) => Promise<T>,
  ): Promise<T>;
  abort(instanceId: string, kind?: InstanceActivityKind): void;
}

/**
 * 代理层只记录连接生命周期，不理解升级状态机。租约有心跳时间，Portal
 * 异常退出后遗留的记录会由判定层自动忽略，不会永久阻塞实例。
 */
export class InstanceActivityTracker implements InstanceActivityMonitor {
  readonly #store: InstanceActivityStore;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #heartbeatIntervalMs: number;
  readonly #activityTouchIntervalMs: number;
  readonly #onHeartbeatError: (error: unknown) => void;
  readonly #active = new Map<string, { instanceId: string; kind: InstanceActivityKind; controller: AbortController }>();

  constructor(options: {
    store: InstanceActivityStore;
    now?: () => Date;
    randomId?: () => string;
    heartbeatIntervalMs?: number;
    activityTouchIntervalMs?: number;
    onHeartbeatError?: (error: unknown) => void;
  }) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
    this.#heartbeatIntervalMs = positiveDuration(options.heartbeatIntervalMs, 15_000);
    this.#activityTouchIntervalMs = positiveDuration(options.activityTouchIntervalMs, this.#heartbeatIntervalMs);
    this.#onHeartbeatError = options.onHeartbeatError ?? (() => undefined);
  }

  async open(instanceId: string, kind: InstanceActivityKind): Promise<InstanceActivityHandle> {
    const openedAt = this.#now().toISOString();
    const lease: InstanceActivityLease = {
      id: this.#randomId(),
      instanceId,
      kind,
      openedAt,
      heartbeatAt: openedAt,
      lastActivityAt: openedAt,
    };
    if (!(await this.#store.tryOpenLease(lease, openedAt))) {
      throw new InstanceActivityAdmissionError("instance_draining");
    }
    const controller = new AbortController();
    this.#active.set(lease.id, { instanceId, kind, controller });
    return new ActivityLeaseSession({
      lease,
      store: this.#store,
      controller,
      now: this.#now,
      activityTouchIntervalMs: this.#activityTouchIntervalMs,
      onClose: () => this.#active.delete(lease.id),
      onFailure: (error) => this.#reportHeartbeatError(error),
    });
  }

  async run<T>(
    instanceId: string,
    kind: InstanceActivityKind,
    operation: (handle: InstanceActivityHandle) => Promise<T>,
  ): Promise<T> {
    const handle = await this.open(instanceId, kind);
    const timer = setInterval(() => {
      // 心跳会记录并上报持久化失败，同时中止连接；定时器只需消费拒绝结果。
      handle.heartbeat().catch(() => undefined);
    }, this.#heartbeatIntervalMs);
    timer.unref();
    try {
      return await operation(handle);
    } finally {
      clearInterval(timer);
      await handle.close().catch((error) => this.#reportHeartbeatError(error));
    }
  }

  abort(instanceId: string, kind?: InstanceActivityKind): void {
    for (const active of this.#active.values()) {
      if (active.instanceId === instanceId && (kind === undefined || active.kind === kind)) {
        active.controller.abort(new InstanceActivityAdmissionError("instance_draining"));
      }
    }
  }

  #reportHeartbeatError(error: unknown): void {
    try {
      this.#onHeartbeatError(error);
    } catch {
      // 错误上报不能阻断租约清理。
    }
  }
}

/** 单个代理连接的持久化租约状态机。 */
class ActivityLeaseSession implements InstanceActivityHandle {
  readonly #lease: InstanceActivityLease;
  readonly #store: InstanceActivityStore;
  readonly #controller: AbortController;
  readonly #now: () => Date;
  readonly #activityTouchIntervalMs: number;
  readonly #onClose: () => void;
  readonly #onFailure: (error: unknown) => void;
  #operationTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;
  #failure: unknown;
  #closed = false;
  #failed = false;
  #touchQueued = false;
  #activityTouched = false;
  #reportedFailure = false;
  #lastActivityWriteAt: number;

  constructor(options: {
    lease: InstanceActivityLease;
    store: InstanceActivityStore;
    controller: AbortController;
    now: () => Date;
    activityTouchIntervalMs: number;
    onClose: () => void;
    onFailure: (error: unknown) => void;
  }) {
    this.#lease = options.lease;
    this.#store = options.store;
    this.#controller = options.controller;
    this.#now = options.now;
    this.#activityTouchIntervalMs = options.activityTouchIntervalMs;
    this.#onClose = options.onClose;
    this.#onFailure = options.onFailure;
    this.#lastActivityWriteAt = Date.parse(options.lease.openedAt);
  }

  get id(): string {
    return this.#lease.id;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  heartbeat(): Promise<void> {
    return this.#enqueue(() => this.#renewNow(false));
  }

  touch(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#failed) return Promise.reject(this.#failure);
    if (!this.#activityWriteDue(this.#now().getTime())) return Promise.resolve();
    if (this.#touchQueued) return this.#operationTail;
    this.#touchQueued = true;
    return this.#enqueue(async () => {
      try {
        if (this.#closed) return;
        if (this.#failed) throw this.#failure;
        if (!this.#activityWriteDue(this.#now().getTime())) return;
        await this.#renewNow(true);
        this.#activityTouched = true;
        this.#lastActivityWriteAt = Date.parse(this.#lease.lastActivityAt);
      } finally {
        this.#touchQueued = false;
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#onClose();
    const closedAt = this.#now().toISOString();
    this.#closePromise = this.#enqueue(async () => {
      // 关闭时间和租约删除必须由持久化层原子提交。否则长连接结束后，
      // worker 可能只看到请求开始时间，在 quiet window 尚未经过时重建实例。
      await this.#store.closeLease(this.#lease.id, this.#lease.instanceId, closedAt);
    });
    return this.#closePromise;
  }

  #enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.#operationTail.then(operation);
    this.#operationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  #activityWriteDue(now: number): boolean {
    return !this.#activityTouched
      || !Number.isFinite(now)
      || !Number.isFinite(this.#lastActivityWriteAt)
      || now - this.#lastActivityWriteAt >= this.#activityTouchIntervalMs;
  }

  async #renewNow(activity: boolean): Promise<void> {
    if (this.#closed) return;
    if (this.#failed) throw this.#failure;
    if (this.#controller.signal.aborted) {
      const reason = this.#controller.signal.reason instanceof Error
        ? this.#controller.signal.reason
        : new InstanceActivityAdmissionError("instance_draining");
      throw this.#fail(reason);
    }
    const touchedAt = this.#now().toISOString();
    this.#lease.heartbeatAt = touchedAt;
    if (activity) this.#lease.lastActivityAt = touchedAt;
    try {
      if (!(await this.#store.renewLease(this.#lease, touchedAt))) {
        throw new InstanceActivityAdmissionError("instance_draining");
      }
    } catch (error) {
      throw this.#fail(error);
    }
  }

  #fail(error: unknown): unknown {
    if (this.#failed) return this.#failure;
    this.#failed = true;
    this.#failure = error;
    this.#controller.abort(error);
    if (!(error instanceof InstanceActivityAdmissionError)) this.#reportFailure(error);
    void this.close().catch((closeError) => this.#reportFailure(closeError));
    return this.#failure;
  }

  #reportFailure(error: unknown): void {
    if (this.#reportedFailure) return;
    this.#reportedFailure = true;
    this.#onFailure(error);
  }
}

export class InstanceActivityAdmissionError extends Error {
  readonly status = 409;

  constructor(readonly code: "instance_draining") {
    super(code);
  }
}

/** 升级 worker 依赖的准入接口；具体实现只负责 drain 互斥和连接收敛。 */
export interface InstanceUpgradeAdmission {
  begin(instanceId: string, rolloutId: string, attemptId: string, mode: InstanceDrainMode): Promise<boolean>;
  clear(instanceId: string, rolloutId: string, attemptId: string): Promise<void>;
}

/**
 * 升级协调层只通过该门闩进入 drain；持久化层负责和新连接原子互斥，
 * 进程内监控器负责立即关闭已经静默的 WebSocket。
 */
export class InstanceUpgradeAdmission implements InstanceUpgradeAdmission {
  readonly #store: InstanceActivityStore & InstanceUpgradeAdmissionStore;
  readonly #tracker: InstanceActivityMonitor;
  readonly #now: () => Date;
  readonly #leaseTimeoutMs: number;
  readonly #quietWindowMs: number;
  readonly #drainTtlMs: number;

  constructor(options: {
    store: InstanceActivityStore & InstanceUpgradeAdmissionStore;
    tracker: InstanceActivityMonitor;
    now?: () => Date;
    leaseTimeoutMs?: number;
    quietWindowMs?: number;
    drainTtlMs?: number;
  }) {
    this.#store = options.store;
    this.#tracker = options.tracker;
    this.#now = options.now ?? (() => new Date());
    this.#leaseTimeoutMs = positiveDuration(options.leaseTimeoutMs, 45_000);
    this.#quietWindowMs = positiveDuration(options.quietWindowMs, 60_000);
    this.#drainTtlMs = positiveDuration(options.drainTtlMs, 2 * 60 * 60_000);
  }

  async begin(instanceId: string, rolloutId: string, attemptId: string, mode: InstanceDrainMode): Promise<boolean> {
    const now = this.#now();
    const admitted = await this.#store.beginInstanceDraining({
      instanceId,
      rolloutId,
      attemptId,
      at: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.#drainTtlMs).toISOString(),
      heartbeatCutoff: new Date(now.getTime() - this.#leaseTimeoutMs).toISOString(),
      websocketActivityCutoff: new Date(now.getTime() - this.#quietWindowMs).toISOString(),
      mode,
    });
    if (admitted) this.#tracker.abort(instanceId, mode === "force" ? undefined : "websocket");
    return admitted;
  }

  clear(instanceId: string, rolloutId: string, attemptId: string): Promise<void> {
    return this.#store.clearInstanceDraining(instanceId, rolloutId, attemptId);
  }
}

interface ActivityObservation {
  sampledAt: number;
  metrics: ContainerActivityMetrics;
}

interface ReadyActivityObservation extends ActivityObservation {
  rolloutId: string;
  attemptId: string | null;
  lastActivityAt: string;
}

/**
 * 安全窗口同时使用代理租约和容器累计指标。单次低 CPU 不能证明空闲；
 * 只有跨越完整静默窗口的两次样本都低负载且网络计数未变化才放行。
 */
export class InstanceUpgradeActivityPolicy {
  readonly #store: InstanceActivityStore;
  readonly #metrics: ProviderMetricsPort;
  readonly #now: () => Date;
  readonly #quietWindowMs: number;
  readonly #leaseTimeoutMs: number;
  readonly #busyCpuPercent: number;
  readonly #observations = new Map<string, ActivityObservation>();
  readonly #readyObservations = new Map<string, ReadyActivityObservation>();

  constructor(options: {
    store: InstanceActivityStore;
    metrics: ProviderMetricsPort;
    now?: () => Date;
    quietWindowMs?: number;
    leaseTimeoutMs?: number;
    busyCpuPercent?: number;
  }) {
    this.#store = options.store;
    this.#metrics = options.metrics;
    this.#now = options.now ?? (() => new Date());
    this.#quietWindowMs = positiveDuration(options.quietWindowMs, 60_000);
    this.#leaseTimeoutMs = positiveDuration(options.leaseTimeoutMs, 45_000);
    this.#busyCpuPercent = options.busyCpuPercent ?? 5;
  }

  async assess(instance: Container, item: UpgradeRolloutItem): Promise<UpgradeActivityAssessment> {
    const now = this.#now();
    const heartbeatCutoff = new Date(now.getTime() - this.#leaseTimeoutMs).toISOString();
    const leases = await this.#store.listActiveLeases(instance.id, heartbeatCutoff);
    if (leases.some((lease) => lease.kind === "http")) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "active_stream" };
    }
    if (leases.some((lease) => (
      lease.kind === "websocket"
      && Date.parse(lease.lastActivityAt) > now.getTime() - this.#quietWindowMs
    ))) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "active_websocket" };
    }

    // 代理租约可能在 Portal 重启时已经被清理，但实例记录中的活动时间
    // 是跨进程持久化的安全下界。近期请求即使已经结束，也必须完整经过
    // quiet window，不能仅凭本轮 Docker 采样就发起 stop/rebuild。
    const persistedActivityAt = Date.parse(instance.lastActivityAt);
    if (!Number.isFinite(persistedActivityAt)) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "activity_timestamp_invalid" };
    }
    if (persistedActivityAt > now.getTime() - this.#quietWindowMs) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "recent_activity" };
    }

    const metricsResult = await readProviderMetrics(this.#metrics, instance.id);
    if (metricsResult.status === "unsupported") {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "activity_metrics_unsupported" };
    }
    if (metricsResult.status === "unavailable") throw metricsResult.error;
    const metrics = metricsResult.value;
    const previous = this.#observations.get(instance.id);
    const unchanged = previous
      && previous.metrics.networkRxBytes === metrics.networkRxBytes
      && previous.metrics.networkTxBytes === metrics.networkTxBytes;
    const elapsed = previous ? now.getTime() - previous.sampledAt : 0;
    const quietForWindow = previous && elapsed >= this.#quietWindowMs;
    const lowCpu = metrics.cpuPercent <= this.#busyCpuPercent
      && (!previous || previous.metrics.cpuPercent <= this.#busyCpuPercent);
    if (unchanged && quietForWindow && lowCpu) {
      // 保存“准入前最后样本”，而不是更早的 quiet-window 基线。drain 后
      // 只需证明这两个相邻样本之间仍无活动，不应再等待一个完整窗口。
      this.#readyObservations.set(instance.id, {
        sampledAt: now.getTime(),
        metrics,
        rolloutId: item.rolloutId,
        attemptId: item.attemptId,
        lastActivityAt: instance.lastActivityAt,
      });
      return { ready: true };
    }

    this.#readyObservations.delete(instance.id);
    // 轮询周期通常短于 quiet window。累计网络未变且 CPU 持续低时必须保留
    // 最早样本，否则每轮都前移基线会让实例永远无法满足静默窗口。
    if (!previous || !unchanged || !lowCpu || !Number.isFinite(elapsed) || elapsed < 0) {
      this.#observations.set(instance.id, { sampledAt: now.getTime(), metrics });
    }
    return { ready: false, reason: "activity_observation" };
  }

  async confirmAfterDrain(instance: Container, item: UpgradeRolloutItem): Promise<UpgradeActivityAssessment> {
    const ready = this.#readyObservations.get(instance.id);
    if (!ready || ready.rolloutId !== item.rolloutId || ready.attemptId !== item.attemptId) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "activity_confirmation_missing" };
    }

    const now = this.#now();
    const heartbeatCutoff = new Date(now.getTime() - this.#leaseTimeoutMs).toISOString();
    const leases = await this.#store.listActiveLeases(instance.id, heartbeatCutoff);
    if (leases.some((lease) => lease.kind === "http")) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "active_stream" };
    }
    if (leases.some((lease) => (
      lease.kind === "websocket"
      && Date.parse(lease.lastActivityAt) > now.getTime() - this.#quietWindowMs
    ))) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "active_websocket" };
    }

    const persistedActivityAt = Date.parse(instance.lastActivityAt);
    if (!Number.isFinite(persistedActivityAt)) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "activity_timestamp_invalid" };
    }
    if (instance.lastActivityAt !== ready.lastActivityAt) {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "recent_activity" };
    }

    const metricsResult = await readProviderMetrics(this.#metrics, instance.id);
    if (metricsResult.status === "unsupported") {
      this.#clearObservations(instance.id);
      return { ready: false, reason: "activity_metrics_unsupported" };
    }
    if (metricsResult.status === "unavailable") throw metricsResult.error;
    const metrics = metricsResult.value;
    const unchanged = ready.metrics.networkRxBytes === metrics.networkRxBytes
      && ready.metrics.networkTxBytes === metrics.networkTxBytes;
    const lowCpu = ready.metrics.cpuPercent <= this.#busyCpuPercent
      && metrics.cpuPercent <= this.#busyCpuPercent;
    this.#readyObservations.delete(instance.id);
    if (unchanged && lowCpu) {
      this.#observations.delete(instance.id);
      return { ready: true };
    }

    this.#observations.set(instance.id, { sampledAt: now.getTime(), metrics });
    return { ready: false, reason: "docker_activity_resumed" };
  }

  #clearObservations(instanceId: string): void {
    this.#observations.delete(instanceId);
    this.#readyObservations.delete(instanceId);
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value! > 0 ? value! : fallback;
}
