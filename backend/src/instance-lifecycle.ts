import { randomUUID } from "node:crypto";
import { toLaunchProfile, type ProvisioningPolicy } from "./instance-policy.js";
import type { Container, User } from "./models.js";
import type {
  ContainerActivityMetrics,
  ContainerCatalogSnapshot,
  ContainerInstance,
  ContainerLaunchProfile,
  ContainerRuntime,
} from "./runtime.js";
import { ContainerRebuildRollbackError } from "./runtime.js";
import type { AppLaunchTarget } from "./app-catalog.js";
import type { WorkspaceExecutionProjection } from "./workspace-execution.js";
import { parseCpuMillis, parseMemoryBytes } from "./provider-adapter-contract.js";
import { QuotaAdmissionError, type QuotaAdmission } from "./quota-admission.js";

const NETWORK_ACTIVITY_BYTES_PER_MINUTE = 64 * 1024;
const COMPUTE_CPU_PERCENT = 2;
const COMPUTE_CPU_CHANGE_PERCENT = 1;
const COMPUTE_STEADY_CPU_PERCENT = 10;
const COMPUTE_MEMORY_CHANGE_BYTES = 16 * 1024 * 1024;
const COMPUTE_PID_CHANGE = 2;
const COMPUTE_GPU_PERCENT = 5;
const COMPUTE_GPU_CHANGE_PERCENT = 2;
const COMPUTE_STEADY_GPU_PERCENT = 10;
const MISSING_RUNTIME_RETRY_COUNT = 3;
const MISSING_RUNTIME_RETRY_DELAY_MS = 50;
const NEVER_ABORT_SIGNAL = new AbortController().signal;

export type LifecycleErrorCode =
  | "container_not_found"
  | "container_owner_mismatch"
  | "container_provider_mismatch"
  | "container_catalog_mismatch"
  | "container_not_ready"
  | "runtime_observation_unavailable"
  | "container_maintenance_busy"
  | "app_version_not_ready"
  | "runtime_rebuild_unsupported"
  | "running_limit_reached"
  | "total_limit_reached";

export class InstanceLifecycleError extends Error {
  constructor(readonly code: LifecycleErrorCode) {
    super(code);
  }
}

export interface LifecycleStore {
  getProvisioningPolicy(): Promise<ProvisioningPolicy>;
  getUser(id: string): Promise<User | null>;
  getContainer(id: string): Promise<Container | null>;
  getContainerForUser(userId: string): Promise<Container | null>;
  getLiveWorkspaceExecutionForUser?(userId: string): Promise<WorkspaceExecutionProjection | null>;
  listContainers(): Promise<Container[]>;
  saveContainer(container: Container): Promise<void>;
  updateContainer(container: Container): Promise<void>;
  touchContainer(id: string, at?: Date): Promise<void>;
  deleteContainer(id: string): Promise<void>;
  markUserAppInitialized(id: string): Promise<void>;
  withCapacityLock?<T>(operation: () => Promise<T>): Promise<T>;
  getLaunchTarget(appId: string): Promise<AppLaunchTarget>;
}

export interface LifecycleAudit {
  (
    actorUserId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata?: unknown,
  ): Promise<void>;
}

export interface ProvisionResult {
  container: Container;
  created: boolean;
}

export interface EnsureDefaultResult extends ProvisionResult {
  reason: "existing" | "created";
}

export interface EnsureDefaultSkipped {
  container: null;
  created: false;
  reason: "disabled" | "already_initialized";
}

export interface IdleSweepResult {
  checked: number;
  stopped: number;
  errors: number;
}

export type ContainerMaintenanceGuard = <T>(
  instanceId: string,
  operation: (signal: AbortSignal) => Promise<T>,
) => Promise<T | null>;

export type WorkspaceDeletionHandler = (
  workspaceId: string,
  signal: AbortSignal,
) => Promise<{ ownerId: string }>;

export interface PinnedRebuildTarget {
  appVersionId: string | null;
  imageArtifactId: string | null;
  imageReference: string;
  launchProfile: ContainerLaunchProfile;
  /** 由目录/rollout 冻结的 App 执行合同；旧目标可省略。 */
  executionContract?: string | null;
}

export interface RebuildOptions {
  useLatestVersion?: boolean;
  target?: PinnedRebuildTarget;
  targetState?: "running" | "stopped";
  rebuildTransactionId?: string;
  signal?: AbortSignal;
  /** 调用方已经持有同一实例的分布式维护租约时使用，避免重复认领。 */
  maintenanceLeaseHeld?: boolean;
}

interface MaintenanceLeaseOptions {
  maintenanceLeaseHeld?: boolean;
  signal?: AbortSignal;
}

interface Reservation {
  id: string;
  policy: ProvisioningPolicy;
  pending: Container;
  launchTarget: AppLaunchTarget;
  quotaReserved: boolean;
}

interface ActivityBaseline {
  sampledAt: number;
  metrics: ContainerActivityMetrics;
}

/**
 * 负责单个 Portal 进程内的生命周期协调。数据库状态仍是权威，进程内的
 * 短期预留用于填补容量检查和下一次 Runtime 操作之间的窗口。
 */
export class InstanceLifecycle {
  readonly #store: LifecycleStore;
  readonly #runtime: ContainerRuntime;
  readonly #audit: LifecycleAudit;
  readonly #now: () => Date;
  readonly #withContainerMaintenance: ContainerMaintenanceGuard;
  readonly #deleteWorkspace: WorkspaceDeletionHandler | null;
  readonly #providerIdForApp: (appId: string) => string | Promise<string>;
  readonly #quotaAdmission: QuotaAdmission | null;
  #globalTail: Promise<void> = Promise.resolve();
  readonly #userTails = new Map<string, Promise<void>>();
  readonly #containerTails = new Map<string, Promise<void>>();
  readonly #activityBaselines = new Map<string, ActivityBaseline>();

  constructor(options: {
    store: LifecycleStore;
    runtime: ContainerRuntime;
    audit?: LifecycleAudit;
    now?: () => Date;
    withContainerMaintenance?: ContainerMaintenanceGuard;
    deleteWorkspace?: WorkspaceDeletionHandler;
    /** Selects a Provider only when a new Workspace is reserved; existing rows stay pinned. */
    providerIdForApp?: (appId: string) => string | Promise<string>;
    /** Optional durable quota port; omitted by the default composition for compatibility. */
    quotaAdmission?: QuotaAdmission;
  }) {
    this.#store = options.store;
    this.#runtime = options.runtime;
    this.#audit = options.audit ?? (async () => undefined);
    this.#now = options.now ?? (() => new Date());
    this.#withContainerMaintenance =
      options.withContainerMaintenance ?? (async (_instanceId, operation) => operation(NEVER_ABORT_SIGNAL));
    this.#deleteWorkspace = options.deleteWorkspace ?? null;
    this.#providerIdForApp = options.providerIdForApp ?? (() => "docker");
    this.#quotaAdmission = options.quotaAdmission ?? null;
  }

  async provisionForUser(
    user: User,
    appId: string,
    options: { startExisting?: boolean; authorizeApp?: (appId: string) => Promise<void> } = {},
  ): Promise<ProvisionResult> {
    return this.#withKey(this.#userTails, user.id, async () =>
      this.#provisionForUserLocked(user, appId, options.startExisting !== false, options.authorizeApp),
    );
  }

  async ensureDefault(
    user: User,
    authorizeApp?: (appId: string) => Promise<void>,
  ): Promise<EnsureDefaultResult | EnsureDefaultSkipped> {
    return this.#withKey(this.#userTails, user.id, async () => {
      const existing = await this.#store.getContainerForUser(user.id);
      if (existing) {
        const result = await this.#returnExisting(existing, user.id, false);
        return { ...result, reason: "existing" };
      }
      await this.#assertNoLiveWorkspaceForUser(user.id);

      const currentUser = (await this.#store.getUser(user.id)) ?? user;
      if (currentUser.appInitializedAt) {
        return { container: null, created: false, reason: "already_initialized" };
      }
      const policy = await this.#store.getProvisioningPolicy();
      if (!policy.autoCreateOnFirstVisit) {
        return { container: null, created: false, reason: "disabled" };
      }
      const result = await this.#provisionForUserLocked(
        currentUser,
        policy.defaultAppId,
        false,
        authorizeApp,
      );
      return { ...result, reason: result.created ? "created" : "existing" };
    });
  }

  async sync(id: string, options: MaintenanceLeaseOptions = {}): Promise<Container> {
    return this.#withContainerLease(
      id,
      options.maintenanceLeaseHeld === true,
      async (signal) =>
        this.#withKey(this.#containerTails, id, async () => {
          signal.throwIfAborted();
          const record = await this.#store.getContainer(id);
          signal.throwIfAborted();
          if (!record) throw new InstanceLifecycleError("container_not_found");
          return this.#syncRecord(await this.#waitForCreation(record, signal), signal);
        }),
      options.signal,
    );
  }

  /**
   * Returns a read-only runtime observation without claiming the instance
   * maintenance lease or mutating the container/rebuild artifacts. Network
   * mode may idempotently reconnect the Portal bridge after a restart.
   */
  async read(id: string, options: Pick<MaintenanceLeaseOptions, "signal"> = {}): Promise<Container> {
    const signal = options.signal ?? NEVER_ABORT_SIGNAL;
    signal.throwIfAborted();
    const record = await this.#store.getContainer(id);
    signal.throwIfAborted();
    if (!record) throw new InstanceLifecycleError("container_not_found");
    const settled = await this.#waitForCreation(record, signal);
    if (!this.#runtime.observe) return settled;
    let instance = await this.#runtime.observe(id, signal);
    // A rebuild commits through Docker renames. During the two rename calls
    // the canonical name can briefly be absent; never turn that observation
    // gap into a persisted/permanent failure for a request that is only read.
    for (let attempt = 0; !instance && attempt < MISSING_RUNTIME_RETRY_COUNT; attempt += 1) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, MISSING_RUNTIME_RETRY_DELAY_MS));
      signal.throwIfAborted();
      instance = await this.#runtime.observe(id, signal);
    }
    signal.throwIfAborted();
    if (!instance) {
      if (settled.status === "failed") return settled;
      throw new InstanceLifecycleError("runtime_observation_unavailable");
    }
    return this.#projectRuntimeInstance(settled, instance);
  }

  async start(id: string, options: MaintenanceLeaseOptions = {}): Promise<Container> {
    return this.#withContainerLease(
      id,
      options.maintenanceLeaseHeld === true,
      (signal) => this.#withKey(this.#containerTails, id, async () => this.#startLocked(id, signal)),
      options.signal,
    );
  }

  async stop(
    id: string,
    reason: "manual_user" | "manual_admin" | "failure" = "manual_user",
    options: MaintenanceLeaseOptions = {},
  ): Promise<Container> {
    return this.#withContainerLease(
      id,
      options.maintenanceLeaseHeld === true,
      (signal) => this.#withKey(this.#containerTails, id, async () => this.#stopLocked(id, reason, signal)),
      options.signal,
    );
  }

  async rebuild(id: string, actorUserId: string | null, options: RebuildOptions = {}): Promise<Container> {
    return this.#withContainerLease(
      id,
      options.maintenanceLeaseHeld === true,
      (signal) =>
        this.#withKey(this.#containerTails, id, () =>
          this.#withGlobal(async () => {
            signal.throwIfAborted();
            if (options.useLatestVersion && options.target)
              throw new InstanceLifecycleError("app_version_not_ready");
            const record = await this.#store.getContainer(id);
            signal.throwIfAborted();
            if (!record) throw new InstanceLifecycleError("container_not_found");
            if (!this.#runtime.rebuild) throw new InstanceLifecycleError("runtime_rebuild_unsupported");
            const wasRecordedRunning = record.status === "running";
            const settled = await this.#waitForCreation(record, signal);
            let current: Container;
            try {
              // Rollout rebuilds carry the desired catalog snapshot explicitly. A
              // deferred Docker candidate may already be the canonical container,
              // but its snapshot is not durable until this rebuild is committed.
              // Do not persist that candidate before the requested target is known.
              current = options.target ? settled : await this.#syncRecord(settled, signal);
            } catch (error) {
              // A missing canonical during a crashed rebuild is reconciled by the
              // Runtime transaction itself. Preserve the durable intent until that
              // transaction proves a replacement, without persisting a false fail.
              if (
                !(error instanceof InstanceLifecycleError) ||
                (error.code !== "runtime_observation_unavailable" &&
                  error.code !== "container_catalog_mismatch")
              )
                throw error;
              current = settled;
            }
            // 普通显式重建沿用实例当前目录与镜像快照；rollout 才能传入固定目标。
            let appVersionId = current.appVersionId ?? null;
            let imageArtifactId = current.imageArtifactId ?? null;
            let imageReference = current.imageReference;
            let executionContract: string | null | undefined;
            if (options.target) {
              appVersionId = options.target.appVersionId;
              imageArtifactId = options.target.imageArtifactId;
              imageReference = options.target.imageReference;
              executionContract = options.target.executionContract;
              if (options.target.launchProfile.imageReference !== imageReference) {
                throw new InstanceLifecycleError("app_version_not_ready");
              }
            } else if (options.useLatestVersion) {
              const latest = await this.#store.getLaunchTarget(current.appId);
              appVersionId = latest.version.id;
              imageArtifactId = latest.version.imageArtifactId ?? null;
              imageReference = latest.imageReference;
              executionContract = latest.version.runtimeContract;
            }
            if (!imageReference) throw new InstanceLifecycleError("app_version_not_ready");
            const expectedCatalogSnapshot: ContainerCatalogSnapshot = {
              appId: current.appId,
              appVersionId,
              imageArtifactId,
              imageReference,
            };
            const launchProfile =
              options.target?.launchProfile ??
              toLaunchProfile(await this.#store.getProvisioningPolicy(), imageReference);
            // Runtime 崩溃可能暂时只留下 `-rebuild-previous`。canonical 查询会先把
            // 记录同步为 failed，因此恢复事务仍需沿用数据库中最后一次持久化的运行意图。
            const shouldRun = options.targetState
              ? options.targetState === "running"
              : current.status === "running" || (current.status === "failed" && wasRecordedRunning);
            try {
              let instance = await this.#runtime.rebuild({
                instanceId: current.id,
                ownerId: current.userId,
                appId: current.appId,
                ...(current.providerId ? { providerId: current.providerId } : {}),
                appVersionId,
                imageArtifactId,
                imageReference,
                ...(executionContract === undefined ? {} : { executionContract }),
                sourceCatalogSnapshot: catalogSnapshot(current),
                launchProfile,
                start: shouldRun,
                ...(options.rebuildTransactionId === undefined
                  ? {}
                  : { rebuildTransactionId: options.rebuildTransactionId }),
                ...(signal === undefined ? {} : { signal }),
              });
              signal.throwIfAborted();
              // 兼容忽略可选 start 标志的自定义 Runtime，显式保持原先的停止意图。
              if (!shouldRun && instance.state === "running")
                instance = await this.#runtime.stop(current.id, signal);
              signal.throwIfAborted();
              if (
                instance.catalogSnapshot &&
                !catalogSnapshotsEqual(instance.catalogSnapshot, expectedCatalogSnapshot)
              ) {
                throw new InstanceLifecycleError("container_catalog_mismatch");
              }
              const updated = await this.#persistRuntimeInstance(
                {
                  ...current,
                  appVersionId,
                  imageArtifactId,
                  imageReference,
                },
                instance,
                current.stopReason,
                shouldRun ? "running" : "stopped",
                expectedCatalogSnapshot,
              );
              this.#activityBaselines.delete(id);
              await this.#audit(actorUserId, "container.rebuild", "container", id, {
                ownerId: current.userId,
                imageReference,
                useLatestVersion: options.useLatestVersion === true,
                pinnedTarget: options.target !== undefined,
                preservedState: shouldRun ? "running" : "stopped",
              });
              return updated;
            } catch (error) {
              if (signal.aborted) throw signal.reason;
              try {
                const recovered =
                  error instanceof ContainerRebuildRollbackError
                    ? error.recoveredInstance
                    : await this.#runtime.get(current.id, signal);
                if (recovered && recovered.ownerId === current.userId) {
                  if (
                    recovered.catalogSnapshot &&
                    !catalogSnapshotsEqual(recovered.catalogSnapshot, expectedCatalogSnapshot)
                  ) {
                    await this.#store.updateContainer({
                      ...current,
                      status: "failed",
                      endpoint: null,
                      stopReason: "failure",
                      updatedAt: this.#timestamp(),
                    });
                  } else {
                    await this.#persistRuntimeInstance(
                      current,
                      recovered,
                      current.stopReason,
                      undefined,
                      expectedCatalogSnapshot,
                    );
                  }
                } else {
                  await this.#store.updateContainer({
                    ...current,
                    status: "failed",
                    endpoint: null,
                    stopReason: "failure",
                    updatedAt: this.#timestamp(),
                  });
                }
              } catch {
                if (signal.aborted) throw signal.reason;
                await this.#store.updateContainer({
                  ...current,
                  status: "failed",
                  endpoint: null,
                  stopReason: "failure",
                  updatedAt: this.#timestamp(),
                });
              }
              throw error;
            }
          }, true),
        ),
      options.signal,
    );
  }

  async remove(id: string, actorUserId: string | null, options: MaintenanceLeaseOptions = {}): Promise<void> {
    await this.#withContainerLease(
      id,
      options.maintenanceLeaseHeld === true,
      async (signal) => {
        if (this.#deleteWorkspace) {
          await this.#withKey(this.#containerTails, id, async () => {
            await this.#withGlobal(async () => {
              signal.throwIfAborted();
              const deleted = await this.#deleteWorkspace!(id, signal);
              await this.#releaseQuota(id, deleted.ownerId);
              this.#activityBaselines.delete(id);
              await this.#store.markUserAppInitialized(deleted.ownerId);
              await this.#audit(actorUserId, "container.delete", "container", id, {
                ownerId: deleted.ownerId,
                tombstone: true,
              });
            }, true);
          });
          return;
        }
        signal.throwIfAborted();
        const initial = await this.#store.getContainer(id);
        signal.throwIfAborted();
        if (!initial) throw new InstanceLifecycleError("container_not_found");
        await this.#withKey(this.#userTails, initial.userId, async () => {
          await this.#withKey(this.#containerTails, id, async () => {
            await this.#withGlobal(async () => {
              let record = await this.#store.getContainer(id);
              if (!record) throw new InstanceLifecycleError("container_not_found");
              record = await this.#waitForCreation(record, signal);
              signal.throwIfAborted();
              await this.#runtime.remove(id, record.userId, signal);
              signal.throwIfAborted();
              await this.#store.deleteContainer(id);
              await this.#releaseQuota(id, record.userId);
              this.#activityBaselines.delete(id);
              // 删除是明确的用户选择；即使启用了首次访问创建，也不能在下一次
              // 看板刷新时静默重建该实例。
              await this.#store.markUserAppInitialized(record.userId);
              await this.#audit(actorUserId, "container.delete", "container", id, { ownerId: record.userId });
            }, true);
          });
        });
      },
      options.signal,
    );
  }

  async sweepIdleContainers(): Promise<IdleSweepResult> {
    const policy = await this.#store.getProvisioningPolicy();
    if (policy.idleStopMinutes === 0) return { checked: 0, stopped: 0, errors: 0 };
    const threshold = this.#now().getTime() - policy.idleStopMinutes * 60_000;
    const candidates = (await this.#store.listContainers()).filter((item) => item.status === "running");
    let stopped = 0;
    let errors = 0;
    for (const candidate of candidates) {
      try {
        await this.#withContainerMaintenance(candidate.id, async (signal) => {
          signal.throwIfAborted();
          await this.#withKey(this.#containerTails, candidate.id, async () => {
            const current = await this.#store.getContainer(candidate.id);
            signal.throwIfAborted();
            if (!current) {
              this.#activityBaselines.delete(candidate.id);
              return;
            }
            if (current.status !== "running") return;
            if (policy.detectNetworkActivity || policy.detectComputeActivity) {
              if (await this.#observeActivity(current.id, policy, signal)) return;
            } else {
              this.#activityBaselines.delete(current.id);
            }
            const activity = Date.parse(current.lastActivityAt || current.updatedAt);
            if (!Number.isFinite(activity) || activity > threshold) return;
            await this.#stopLocked(current.id, "idle", signal);
            stopped += 1;
            await this.#audit(null, "container.idle_stop", "container", current.id, {
              idleStopMinutes: policy.idleStopMinutes,
              detectNetworkActivity: policy.detectNetworkActivity,
              detectComputeActivity: policy.detectComputeActivity,
            });
          });
        });
      } catch {
        errors += 1;
      }
    }
    return { checked: candidates.length, stopped, errors };
  }

  async #reserveProvision(
    user: User,
    appId: string,
    authorizeApp?: (appId: string) => Promise<void>,
  ): Promise<Reservation | { existing: Container }> {
    return this.#withGlobal(async () => {
      const existing = await this.#store.getContainerForUser(user.id);
      if (existing) return { existing };
      await this.#assertNoLiveWorkspaceForUser(user.id);
      await authorizeApp?.(appId);
      const policy = await this.#store.getProvisioningPolicy();
      const launchTarget = await this.#store.getLaunchTarget(appId);
      const all = await this.#store.listContainers();
      if (all.length >= policy.maxTotalInstances) {
        throw new InstanceLifecycleError("total_limit_reached");
      }
      const occupied = all.filter((item) => item.status === "running" || item.status === "creating").length;
      if (occupied >= policy.maxRunningInstances) {
        throw new InstanceLifecycleError("running_limit_reached");
      }

      const id = randomUUID();
      const providerId = await this.#providerIdForApp(appId);
      let quotaReserved = false;
      if (this.#quotaAdmission) {
        const memoryBytes = parseMemoryBytes(policy.resources.memory);
        const cpuMillis = parseCpuMillis(policy.resources.cpus);
        if (memoryBytes === undefined || cpuMillis === undefined) {
          throw new QuotaAdmissionError("quota_reservation_conflict");
        }
        await this.#quotaAdmission.reserve({
          reservationId: id,
          userId: user.id,
          providerId,
          desiredState: "running",
          cpuMillis,
          memoryBytes,
          pidsLimit: policy.resources.pidsLimit,
        });
        quotaReserved = true;
      }
      const now = this.#timestamp();
      const pending: Container = {
        id,
        userId: user.id,
        appId,
        providerId,
        runtimeId: "pending",
        status: "creating",
        endpoint: null,
        stopReason: null,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        appVersionId: launchTarget.version.id,
        imageArtifactId: launchTarget.version.imageArtifactId ?? null,
        imageReference: launchTarget.imageReference,
      };
      try {
        await this.#store.saveContainer(pending);
      } catch (error) {
        if (quotaReserved) await this.#releaseQuota(id, user.id);
        throw error;
      }
      return { id, policy, pending, launchTarget, quotaReserved };
    }, true);
  }

  async #provisionForUserLocked(
    user: User,
    appId: string,
    startExisting: boolean,
    authorizeApp?: (appId: string) => Promise<void>,
  ): Promise<ProvisionResult> {
    const existing = await this.#store.getContainerForUser(user.id);
    if (existing) return this.#returnExisting(existing, user.id, startExisting);
    await this.#assertNoLiveWorkspaceForUser(user.id);

    const reservation = await this.#reserveProvision(user, appId, authorizeApp);
    if ("existing" in reservation) {
      return this.#returnExisting(reservation.existing, user.id, startExisting);
    }

    let container: Container;
    try {
      const instance = await this.#runtime.provision({
        instanceId: reservation.id,
        ownerId: user.id,
        appId: reservation.pending.appId,
        ...(reservation.pending.providerId ? { providerId: reservation.pending.providerId } : {}),
        appVersionId: reservation.pending.appVersionId,
        imageArtifactId: reservation.pending.imageArtifactId,
        imageReference: reservation.pending.imageReference,
        ...(reservation.launchTarget.version.runtimeContract === undefined
          ? {}
          : { executionContract: reservation.launchTarget.version.runtimeContract }),
        launchProfile: toLaunchProfile(reservation.policy, reservation.launchTarget.imageReference),
      });
      container = await this.#persistRuntimeInstance(reservation.pending, instance);
    } catch (error) {
      try {
        await this.#store.updateContainer({
          ...reservation.pending,
          status: "failed",
          endpoint: null,
          stopReason: "failure",
          updatedAt: this.#timestamp(),
        });
      } finally {
        // 资源账本清理不能依赖失败状态写回；数据库短暂不可用时也不能
        // 让一次已经失败的创建永久占住配额。
        if (reservation.quotaReserved) await this.#releaseQuota(reservation.id, user.id);
      }
      throw error;
    }
    await this.#store.markUserAppInitialized(user.id);
    return { container, created: true };
  }

  async #assertNoLiveWorkspaceForUser(userId: string): Promise<void> {
    const liveWorkspace = await this.#store.getLiveWorkspaceExecutionForUser?.(userId);
    // 删除事务保留 durable row；在 tombstone 提交前创建替代 Workspace 会绕过
    // 删除 fencing，并最终撞上数据库的 live-user 唯一约束。
    if (liveWorkspace) throw new InstanceLifecycleError("container_not_ready");
  }

  async #returnExisting(record: Container, userId: string, startExisting: boolean): Promise<ProvisionResult> {
    record = await this.#waitForCreation(record);
    await this.#store.markUserAppInitialized(userId);
    // Runtime 查询可能提交或回滚中断的 rebuild 工件，必须和 rollout worker
    // 共用同一实例维护租约，不能从首次访问路径绕过分布式互斥。
    const current = await this.sync(record.id);
    if (startExisting && current.status === "stopped") {
      return { container: await this.start(current.id), created: false };
    }
    return { container: current, created: false };
  }

  async #waitForCreation(record: Container, signal = NEVER_ABORT_SIGNAL): Promise<Container> {
    if (record.status !== "creating") return record;
    const deadline = Date.now() + 120_000;
    let current = record;
    while (current.status === "creating" && Date.now() < deadline) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 100));
      signal.throwIfAborted();
      const refreshed = await this.#store.getContainer(record.id);
      if (!refreshed) throw new InstanceLifecycleError("container_not_found");
      current = refreshed;
    }
    if (current.status === "creating") throw new InstanceLifecycleError("container_not_ready");
    return current;
  }

  async #startLocked(id: string, signal = NEVER_ABORT_SIGNAL): Promise<Container> {
    return this.#withGlobal(async () => {
      signal.throwIfAborted();
      const record = await this.#store.getContainer(id);
      signal.throwIfAborted();
      if (!record) throw new InstanceLifecycleError("container_not_found");
      const current = await this.#syncRecord(await this.#waitForCreation(record, signal), signal);
      if (current.status === "running") return current;
      if (current.status !== "stopped") throw new InstanceLifecycleError("container_not_ready");
      const fresh = await this.#store.getContainer(id);
      signal.throwIfAborted();
      if (!fresh) throw new InstanceLifecycleError("container_not_found");
      if (fresh.status === "running") return this.#syncRecord(fresh, signal);
      if (fresh.status !== "stopped") throw new InstanceLifecycleError("container_not_ready");
      const policy = await this.#store.getProvisioningPolicy();
      const running = (await this.#store.listContainers()).filter(
        (item) => item.status === "running" || item.status === "creating",
      ).length;
      if (running >= policy.maxRunningInstances) {
        throw new InstanceLifecycleError("running_limit_reached");
      }
      this.#activityBaselines.delete(id);
      let quotaTransitioned = false;
      try {
        if (this.#quotaAdmission) {
          quotaTransitioned = await this.#quotaAdmission.transition(id, "running");
          if (!quotaTransitioned) throw new QuotaAdmissionError("quota_reservation_not_found");
        }
        const instance = await this.#runtime.start(id, signal);
        signal.throwIfAborted();
        return this.#persistRuntimeInstance(current, instance, current.stopReason, "running");
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof QuotaAdmissionError && error.code === "quota_reservation_not_found") throw error;
        if (quotaTransitioned) {
          await this.#quotaAdmission?.transition(id, "stopped").catch(() => undefined);
        }
        const recovered =
          error instanceof ContainerRebuildRollbackError
            ? error.recoveredInstance
            : await this.#runtime.get(id, signal).catch(() => null);
        if (signal.aborted) throw signal.reason;
        if (recovered && recovered.ownerId === current.userId) {
          await this.#persistRuntimeInstance(current, recovered, current.stopReason);
        }
        throw error;
      }
    }, true);
  }

  async #stopLocked(
    id: string,
    reason: "idle" | "manual_user" | "manual_admin" | "failure",
    signal = NEVER_ABORT_SIGNAL,
  ): Promise<Container> {
    return this.#withGlobal(async () => {
      signal.throwIfAborted();
      const record = await this.#store.getContainer(id);
      signal.throwIfAborted();
      if (!record) throw new InstanceLifecycleError("container_not_found");
      const current = await this.#syncRecord(await this.#waitForCreation(record, signal), signal);
      if (current.status === "stopped") {
        const stopped = { ...current, stopReason: reason, updatedAt: this.#timestamp() };
        await this.#store.updateContainer(stopped);
        return stopped;
      }
      if (current.status !== "running") throw new InstanceLifecycleError("container_not_ready");
      let quotaTransitioned = false;
      try {
        if (this.#quotaAdmission) {
          quotaTransitioned = await this.#quotaAdmission.transition(id, "stopped");
        }
        const instance = await this.#runtime.stop(id, signal);
        signal.throwIfAborted();
        return this.#persistRuntimeInstance(current, instance, reason);
      } catch (error) {
        if (quotaTransitioned) {
          await this.#quotaAdmission?.transition(id, "running").catch(() => undefined);
        }
        throw error;
      }
    }, true);
  }

  async #syncRecord(record: Container, signal = NEVER_ABORT_SIGNAL): Promise<Container> {
    signal.throwIfAborted();
    let instance = await this.#runtime.get(record.id, signal);
    // Docker 重建通过两次 rename 提交。其他 Portal 进程可能命中两次 rename
    // 之间的短暂空窗，因此先重试 inspect；持续缺失属于运行时观测不可用，
    // 不能在尚未证明容器永久失败时改写数据库状态。
    for (
      let attempt = 0;
      !instance && record.status !== "failed" && attempt < MISSING_RUNTIME_RETRY_COUNT;
      attempt += 1
    ) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, MISSING_RUNTIME_RETRY_DELAY_MS));
      signal.throwIfAborted();
      instance = await this.#runtime.get(record.id, signal);
    }
    if (!instance) {
      if (record.status === "failed") return record;
      throw new InstanceLifecycleError("runtime_observation_unavailable");
    }
    return this.#persistRuntimeInstance(record, instance);
  }

  async #persistRuntimeInstance(
    record: Container,
    instance: ContainerInstance,
    stopReason = record.stopReason,
    expectedState?: "running" | "stopped",
    expectedCatalogSnapshot?: ContainerCatalogSnapshot,
  ): Promise<Container> {
    const latest = await this.#store.getContainer(record.id);
    const updated = this.#projectRuntimeInstance(
      record,
      instance,
      stopReason,
      expectedState,
      latest?.lastActivityAt,
      expectedCatalogSnapshot,
    );
    await this.#store.updateContainer(updated);
    if (updated.status !== "running") this.#activityBaselines.delete(record.id);
    return updated;
  }

  #projectRuntimeInstance(
    record: Container,
    instance: ContainerInstance,
    stopReason = record.stopReason,
    expectedState?: "running" | "stopped",
    latestActivityAt?: string,
    expectedCatalogSnapshot?: ContainerCatalogSnapshot,
  ): Container {
    if (instance.ownerId !== record.userId) {
      throw new InstanceLifecycleError("container_owner_mismatch");
    }
    const expectedProviderId = record.providerId ?? "docker";
    if (instance.providerId && instance.providerId !== expectedProviderId) {
      throw new InstanceLifecycleError("container_provider_mismatch");
    }
    const snapshot = instance.catalogSnapshot;
    if (snapshot && snapshot.appId !== record.appId) {
      throw new InstanceLifecycleError("container_catalog_mismatch");
    }
    if (snapshot && expectedCatalogSnapshot && !catalogSnapshotsEqual(snapshot, expectedCatalogSnapshot)) {
      throw new InstanceLifecycleError("container_catalog_mismatch");
    }
    const snapshotRecord = snapshot
      ? {
          ...record,
          appVersionId: snapshot.appVersionId,
          imageArtifactId: snapshot.imageArtifactId,
          imageReference: snapshot.imageReference,
        }
      : record;
    const stoppedUnexpectedly =
      expectedState === "running"
        ? instance.state === "stopped"
        : expectedState === undefined &&
          record.status === "running" &&
          instance.state === "stopped" &&
          stopReason === null;
    const preserveFailure =
      record.status === "failed" && !instance.rebuildRecovered && instance.state === "stopped";
    const updated: Container = {
      ...snapshotRecord,
      runtimeId: instance.runtimeId,
      status: stoppedUnexpectedly || preserveFailure ? "failed" : instance.state,
      endpoint: stoppedUnexpectedly || preserveFailure ? null : instance.endpoint,
      stopReason:
        stoppedUnexpectedly || preserveFailure || instance.state === "failed"
          ? "failure"
          : instance.state === "running"
            ? null
            : stopReason,
      updatedAt: this.#timestamp(),
      lastActivityAt: latestActivityAt
        ? latestTimestamp(record.lastActivityAt, latestActivityAt)
        : record.lastActivityAt,
    };
    return updated;
  }

  async #observeActivity(
    id: string,
    policy: Pick<ProvisioningPolicy, "detectNetworkActivity" | "detectComputeActivity">,
    signal = NEVER_ABORT_SIGNAL,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const sampledAt = this.#now().getTime();
    if (!Number.isFinite(sampledAt)) throw new Error("invalid activity sample time");
    const metrics = await this.#runtime.sampleActivity(id, signal);
    signal.throwIfAborted();
    const numericMetrics = [
      metrics.networkRxBytes,
      metrics.networkTxBytes,
      metrics.cpuPercent,
      metrics.memoryWorkingSetBytes,
      metrics.pids,
      ...(metrics.gpuUtilizationPercent === undefined ? [] : [metrics.gpuUtilizationPercent]),
    ];
    if (
      numericMetrics.some((value) => !Number.isFinite(value) || value < 0) ||
      !Number.isSafeInteger(metrics.pids)
    ) {
      throw new Error("runtime returned invalid activity metrics");
    }
    const previous = this.#activityBaselines.get(id);
    this.#activityBaselines.set(id, { sampledAt, metrics });
    if (!previous) {
      await this.#store.touchContainer(id, new Date(sampledAt));
      return true;
    }

    const elapsed = Math.max(1, sampledAt - previous.sampledAt);
    const received = positiveDelta(metrics.networkRxBytes, previous.metrics.networkRxBytes);
    const transmitted = positiveDelta(metrics.networkTxBytes, previous.metrics.networkTxBytes);
    const meaningfulNetworkBytes = (NETWORK_ACTIVITY_BYTES_PER_MINUTE * elapsed) / 60_000;
    const networkActive = policy.detectNetworkActivity && received + transmitted >= meaningfulNetworkBytes;
    const cpuChanging =
      metrics.cpuPercent >= COMPUTE_CPU_PERCENT &&
      Math.abs(metrics.cpuPercent - previous.metrics.cpuPercent) >= COMPUTE_CPU_CHANGE_PERCENT;
    const gpuChanging =
      metrics.gpuUtilizationPercent !== undefined &&
      metrics.gpuUtilizationPercent >= COMPUTE_GPU_PERCENT &&
      Math.abs(metrics.gpuUtilizationPercent - (previous.metrics.gpuUtilizationPercent ?? 0)) >=
        COMPUTE_GPU_CHANGE_PERCENT;
    const computeActive =
      policy.detectComputeActivity &&
      // 即使采样值稳定，持续且明显非空闲的负载仍算活动；变化阈值用于识别
      // 较低但正在变化的稳定负载。
      (metrics.cpuPercent >= COMPUTE_STEADY_CPU_PERCENT ||
        (metrics.gpuUtilizationPercent !== undefined &&
          metrics.gpuUtilizationPercent >= COMPUTE_STEADY_GPU_PERCENT) ||
        cpuChanging ||
        Math.abs(metrics.memoryWorkingSetBytes - previous.metrics.memoryWorkingSetBytes) >=
          COMPUTE_MEMORY_CHANGE_BYTES ||
        Math.abs(metrics.pids - previous.metrics.pids) >= COMPUTE_PID_CHANGE ||
        gpuChanging);
    if (networkActive || computeActive) await this.#store.touchContainer(id, new Date(sampledAt));
    return networkActive || computeActive;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }

  /** 配额账本是删除后的旁路清理；失败不能让已完成的破坏性删除回滚成假失败。 */
  async #releaseQuota(reservationId: string, ownerId: string): Promise<void> {
    if (!this.#quotaAdmission) return;
    try {
      await this.#quotaAdmission.release(reservationId);
    } catch (error) {
      await this.#audit(null, "quota.release.failed", "container", reservationId, {
        ownerId,
        error: error instanceof QuotaAdmissionError ? error.code : "quota_release_failed",
      }).catch(() => undefined);
    }
  }

  async #withContainerLease<T>(
    instanceId: string,
    leaseAlreadyHeld: boolean,
    operation: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (leaseAlreadyHeld) return operation(callerSignal ?? NEVER_ABORT_SIGNAL);
    const result = await this.#withContainerMaintenance(instanceId, (leaseSignal) =>
      operation(combineAbortSignals(leaseSignal, callerSignal)),
    );
    if (result === null) throw new InstanceLifecycleError("container_maintenance_busy");
    return result;
  }

  async #withGlobal<T>(operation: () => Promise<T>, distributed = false): Promise<T> {
    const previous = this.#globalTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#globalTail = previous.catch(() => undefined).then(() => current);
    await previous.catch(() => undefined);
    try {
      return distributed && this.#store.withCapacityLock
        ? await this.#store.withCapacityLock(operation)
        : await operation();
    } finally {
      release();
    }
  }

  async #withKey<T>(map: Map<string, Promise<void>>, key: string, operation: () => Promise<T>): Promise<T> {
    const previous = map.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    map.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (map.get(key) === tail) map.delete(key);
    }
  }
}

function latestTimestamp(left: string, right: string): string {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime)) return right;
  if (!Number.isFinite(rightTime)) return left;
  return rightTime > leftTime ? right : left;
}

function positiveDelta(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return 0;
  return current >= previous ? current - previous : 0;
}

function combineAbortSignals(leaseSignal: AbortSignal, callerSignal?: AbortSignal): AbortSignal {
  if (leaseSignal === NEVER_ABORT_SIGNAL && callerSignal) return callerSignal;
  return callerSignal ? AbortSignal.any([leaseSignal, callerSignal]) : leaseSignal;
}

function catalogSnapshot(container: Container): ContainerCatalogSnapshot | undefined {
  if (!container.imageReference) return undefined;
  return {
    appId: container.appId,
    appVersionId: container.appVersionId ?? null,
    imageArtifactId: container.imageArtifactId ?? null,
    imageReference: container.imageReference,
  };
}

function catalogSnapshotsEqual(left: ContainerCatalogSnapshot, right: ContainerCatalogSnapshot): boolean {
  return (
    left.appId === right.appId &&
    left.appVersionId === right.appVersionId &&
    left.imageArtifactId === right.imageArtifactId &&
    left.imageReference === right.imageReference
  );
}

export function isLifecycleCapacityError(error: unknown): error is InstanceLifecycleError {
  return (
    error instanceof InstanceLifecycleError &&
    (error.code === "total_limit_reached" || error.code === "running_limit_reached")
  );
}
