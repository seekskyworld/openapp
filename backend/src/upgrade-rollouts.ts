import { randomUUID } from "node:crypto";
import type {
  ContainerFailureDiagnostics,
  ContainerLaunchProfile,
} from "@openapp/container-runtime";

import type { AppLaunchTarget } from "./app-catalog.js";
import { ProviderOperationError, type ProviderCapabilityResult } from "./execution-provider.js";
import { toLaunchProfile, type ProvisioningPolicy } from "./instance-policy.js";
import type { Container, ContainerStatus } from "./models.js";
import { sanitizeSensitiveText } from "./sensitive-data.js";

const INTERRUPTED_ATTEMPT_RECOVERY_GRACE_MS = 10 * 60_000;
const STORE_CAS_RETRY_LIMIT = 5;
const DEFAULT_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;
const DEFAULT_MAX_REBUILD_ATTEMPTS = 120;
const MAX_ROLLOUT_INSTANCES = 10_000;

export type UpgradeRolloutStatus = "running" | "succeeded" | "partial_failed" | "cancelled" | "needs_attention";
export type UpgradeRolloutTaskKind = "image_upgrade" | "rebuild_same_image" | "apply_resource_policy" | "instance_recovery";
export type UpgradeRolloutItemStatus =
  | "queued"
  | "assessing"
  | "waiting_for_idle"
  | "draining"
  | "rebuilding"
  | "verifying"
  | "awaiting_first_start"
  | "succeeded"
  | "superseded"
  | "failed"
  | "cancelled"
  | "needs_attention";

export interface UpgradeRollout {
  id: string;
  revision: number;
  actorUserId: string;
  status: UpgradeRolloutStatus;
  taskKind: UpgradeRolloutTaskKind;
  useLatestVersion: boolean;
  requested: number;
  completed: number;
  succeeded: number;
  /** 已被后续安全部署替代的项目数；不计入健康成功。 */
  superseded?: number;
  failed: number;
  waiting: number;
  upgrading: number;
  needsAttention: number;
  idempotencyKey: string | null;
  requestFingerprint: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface UpgradeRolloutItem {
  rolloutId: string;
  instanceId: string;
  position: number;
  revision: number;
  userId: string;
  appId: string;
  sourceStatus: ContainerStatus;
  desiredState: "running" | "stopped";
  sourceAppVersionId: string | null;
  sourceImageArtifactId: string | null;
  sourceImageReference: string | null;
  targetAppVersionId: string | null;
  targetImageArtifactId: string | null;
  targetImageReference: string;
  targetRuntimeContract: string | null;
  launchProfile: ContainerLaunchProfile;
  /** 用户显式触发的 failed 实例恢复任务，使用独立的三次失败预算。 */
  recovery?: boolean;
  diagnostics?: UpgradeRolloutDiagnostics | null;
  status: UpgradeRolloutItemStatus;
  blocker: string | null;
  error: string | null;
  forceRequested: boolean;
  /** 当前执行代次的 fencing token；等待首次健康启动时同时作为 Runtime rebuild transaction id。 */
  attemptId: string | null;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastCheckedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpgradeRolloutDiagnostics {
  capturedAt: string;
  error: string | null;
  capabilityStatus?: "supported" | "unsupported" | "unavailable";
  containerRole?: ContainerFailureDiagnostics["containerRole"];
  exitCode?: number | null;
  oomKilled?: boolean | null;
  health?: string | null;
  memoryLimit?: string | null;
  memorySwapLimit?: string | null;
  cpus?: string | null;
  pidsLimit?: number | null;
  logTail?: string | null;
}

export interface UpgradeRolloutDetail {
  rollout: UpgradeRollout;
  items: UpgradeRolloutItem[];
}

export type UpgradeRolloutTargetReference = Pick<
  UpgradeRolloutItem,
  | "rolloutId"
  | "instanceId"
  | "appId"
  | "sourceAppVersionId"
  | "sourceImageArtifactId"
  | "sourceImageReference"
  | "targetAppVersionId"
  | "targetImageArtifactId"
  | "targetImageReference"
  | "status"
>;

export interface UpgradeRolloutStore {
  createRollout(rollout: UpgradeRollout, items: UpgradeRolloutItem[]): Promise<UpgradeRolloutDetail>;
  findRolloutByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<UpgradeRolloutDetail | null>;
  findLatestRecovery?(actorUserId: string, instanceId: string): Promise<UpgradeRolloutDetail | null>;
  getRollout(id: string): Promise<UpgradeRolloutDetail | null>;
  listRollouts(limit?: number): Promise<UpgradeRollout[]>;
  listActiveTargetReferences(): Promise<UpgradeRolloutTargetReference[]>;
  listDueItems(at: string, limit: number): Promise<UpgradeRolloutItem[]>;
  /** Optional direct scan used to recover historical proof-loss items beyond the rollout list page. */
  listLegacyFirstStartProofItems?(): Promise<UpgradeRolloutItem[]>;
  compareAndSaveItem(item: UpgradeRolloutItem, expectedRevision: number): Promise<UpgradeRolloutItem | null>;
  /** 接受新批次的 Runtime 基线后，结算同实例更早的待首次启动项目。 */
  supersedeDeferredItemsBefore(rolloutId: string, instanceId: string, at: string): Promise<string[]>;
  /** 在一个持久化事务中提交当前安全部署点并结算更早的待首次启动项目。 */
  commitDeploymentCheckpoint(
    item: UpgradeRolloutItem,
    expectedRevision: number,
    at: string,
    supersedeEarlier?: boolean,
  ): Promise<{ item: UpgradeRolloutItem; affectedRolloutIds: string[] } | null>;
  compareAndSaveRollout(rollout: UpgradeRollout, expectedRevision: number): Promise<UpgradeRollout | null>;
  recoverInterruptedItems(cutoff: string, recoveredAt: string): Promise<number>;
}

export class UpgradeRolloutConflictError extends Error {
  readonly status: number;

  constructor(readonly code = "upgrade_rollout_conflict") {
    super(code);
    this.status = code.endsWith("_not_found") || code === "container_not_found"
      ? 404
      : code.startsWith("invalid_")
        ? 400
        : 409;
  }
}

export interface UpgradeRolloutSource {
  getContainer(id: string): Promise<Container | null>;
  getLaunchTarget(appId: string): Promise<AppLaunchTarget>;
  getProvisioningPolicy(): Promise<ProvisioningPolicy>;
}

export interface UpgradeActivityAssessment {
  ready: boolean;
  reason?: string;
}

export interface UpgradeActivityPolicy {
  assess(instance: Container, item: UpgradeRolloutItem): Promise<UpgradeActivityAssessment>;
  confirmAfterDrain?(instance: Container, item: UpgradeRolloutItem): Promise<UpgradeActivityAssessment>;
}

export interface UpgradeExecutor {
  acceptDeferredCandidate?(item: UpgradeRolloutItem, signal: AbortSignal): Promise<boolean>;
  rebuild(item: UpgradeRolloutItem, actorUserId: string, signal: AbortSignal): Promise<void>;
  inspectRebuild?(
    item: UpgradeRolloutItem,
    signal: AbortSignal,
  ): Promise<{ status: "pending" | "committed" | "not_found" | "inconsistent" } | null>;
  diagnose?(
    item: UpgradeRolloutItem,
    signal: AbortSignal,
  ): Promise<ProviderCapabilityResult<ContainerFailureDiagnostics>>;
}

export interface UpgradeAdmission {
  begin(instanceId: string, rolloutId: string, attemptId: string, mode: "graceful" | "force"): Promise<boolean>;
  clear(instanceId: string, rolloutId: string, attemptId: string): Promise<void>;
}

export interface CreateUpgradeRolloutInput {
  actorUserId: string;
  instanceIds: string[];
  useLatestVersion: boolean;
  taskKind?: UpgradeRolloutTaskKind;
  desiredState?: "running" | "stopped";
  recovery?: boolean;
  idempotencyKey?: string;
}

export type UpgradeRolloutIdempotencyConflictCheck = (
  actorUserId: string,
  idempotencyKey: string,
) => Promise<boolean>;

interface RolloutCatalogSnapshot {
  appVersionId: string | null;
  imageArtifactId: string | null;
  imageReference: string;
  runtimeContract: string | null;
}

export class UpgradeRolloutService {
  readonly #store: UpgradeRolloutStore;
  readonly #source: UpgradeRolloutSource;
  readonly #idempotencyConflicts: UpgradeRolloutIdempotencyConflictCheck;
  readonly #now: () => Date;
  readonly #randomId: () => string;

  constructor(options: {
    store: UpgradeRolloutStore;
    source: UpgradeRolloutSource;
    idempotencyConflicts?: UpgradeRolloutIdempotencyConflictCheck;
    now?: () => Date;
    randomId?: () => string;
  }) {
    this.#store = options.store;
    this.#source = options.source;
    this.#idempotencyConflicts = options.idempotencyConflicts ?? (async () => false);
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  async create(input: CreateUpgradeRolloutInput): Promise<UpgradeRolloutDetail> {
    const instanceIds = uniqueInstanceIds(input.instanceIds);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const taskKind = input.taskKind ?? (input.useLatestVersion ? "image_upgrade" : "rebuild_same_image");
    const useLatestVersion = taskKind === "image_upgrade";
    const requestFingerprint = JSON.stringify({
      instanceIds: [...instanceIds].sort(),
      taskKind,
      useLatestVersion,
    });
    const createdAt = this.#now().toISOString();
    const rolloutId = this.#randomId();
    const replay = await this.#findReplay(input.actorUserId, idempotencyKey, requestFingerprint);
    if (replay) return replay;
    const items = await this.#buildItems(
      instanceIds,
      useLatestVersion,
      rolloutId,
      createdAt,
      input.desiredState,
      input.recovery === true || taskKind === "instance_recovery",
    );
    const rollout = this.#newRollout({ ...input, taskKind, useLatestVersion }, items.length, {
      id: rolloutId,
      idempotencyKey,
      requestFingerprint,
      createdAt,
    });
    const detail = await this.#createRollout(rollout, items);
    if (detail.rollout.requestFingerprint !== requestFingerprint) {
      throw new UpgradeRolloutConflictError("idempotency_key_conflict");
    }
    return detail;
  }

  async createRecovery(input: {
    actorUserId: string;
    instanceId: string;
    idempotencyKey?: string;
  }): Promise<UpgradeRolloutDetail> {
    const latest = await this.#latestRecovery(input.actorUserId, input.instanceId);
    if (latest && latest.rollout.status === "running") return latest;
    // Keep concurrent clicks on the same failed generation idempotent, while
    // allowing a later failure (or a cancelled/attentioned task) to create a
    // fresh durable recovery batch.
    const baseKey = input.idempotencyKey ?? `instance-recovery:${input.instanceId}`;
    const generationKey = `${baseKey}:${latest?.rollout.id ?? "initial"}`;
    return this.create({
      actorUserId: input.actorUserId,
      instanceIds: [input.instanceId],
      taskKind: "instance_recovery",
      useLatestVersion: false,
      desiredState: "running",
      recovery: true,
      idempotencyKey: generationKey,
    });
  }

  async getRecovery(actorUserId: string, instanceId: string): Promise<UpgradeRolloutDetail | null> {
    return this.#latestRecovery(actorUserId, instanceId);
  }

  async #latestRecovery(actorUserId: string, instanceId: string): Promise<UpgradeRolloutDetail | null> {
    if (this.#store.findLatestRecovery) {
      return this.#store.findLatestRecovery(actorUserId, instanceId);
    }
    const summaries = await this.#store.listRollouts(500);
    for (const summary of summaries) {
      if (summary.actorUserId !== actorUserId || summary.taskKind !== "instance_recovery") continue;
      const detail = await this.#store.getRollout(summary.id);
      if (detail?.items.some((item) => item.instanceId === instanceId && item.recovery === true)) return detail;
    }
    return null;
  }

  async #findReplay(
    actorUserId: string,
    idempotencyKey: string | null,
    requestFingerprint: string,
  ): Promise<UpgradeRolloutDetail | null> {
    if (!idempotencyKey) return null;
    const existing = await this.#store.findRolloutByIdempotencyKey(actorUserId, idempotencyKey);
    if (existing) {
      if (existing.rollout.requestFingerprint !== requestFingerprint) {
        throw new UpgradeRolloutConflictError("idempotency_key_conflict");
      }
      return existing;
    }
    if (await this.#idempotencyConflicts(actorUserId, idempotencyKey)) {
      throw new UpgradeRolloutConflictError("idempotency_key_conflict");
    }
    return null;
  }

  async #buildItems(
    instanceIds: string[],
    useLatestVersion: boolean,
    rolloutId: string,
    createdAt: string,
    desiredStateOverride?: "running" | "stopped",
    recovery = false,
  ): Promise<UpgradeRolloutItem[]> {
    const [policy, ...containers] = await Promise.all([
      this.#source.getProvisioningPolicy(),
      ...instanceIds.map((id) => this.#source.getContainer(id)),
    ]);
    const targets = new Map<string, Promise<AppLaunchTarget>>();
    return Promise.all(containers.map(async (container, position) => {
      if (!container) throw new UpgradeRolloutConflictError("container_not_found");
      const target = await this.#resolveTarget(container, useLatestVersion, targets);
      return {
        rolloutId,
        instanceId: container.id,
        position,
        revision: 1,
        userId: container.userId,
        appId: container.appId,
        sourceStatus: container.status,
        // creating 由默认 provision 流程承诺最终运行；failed 默认保留停止意图，
        // 只有显式恢复任务才覆盖为 running。
        desiredState: desiredStateOverride
          ?? (container.status === "running" || container.status === "creating" ? "running" : "stopped"),
        sourceAppVersionId: container.appVersionId ?? null,
        sourceImageArtifactId: container.imageArtifactId ?? null,
        sourceImageReference: container.imageReference ?? null,
        targetAppVersionId: target.appVersionId,
        targetImageArtifactId: target.imageArtifactId,
        targetImageReference: target.imageReference,
        targetRuntimeContract: target.runtimeContract,
        launchProfile: toLaunchProfile(policy, target.imageReference),
        recovery,
        status: "queued" as const,
        blocker: null,
        error: null,
        forceRequested: false,
        attemptId: null,
        attemptCount: 0,
        nextAttemptAt: createdAt,
        lastCheckedAt: null,
        startedAt: null,
        finishedAt: null,
        createdAt,
        updatedAt: createdAt,
      };
    }));
  }

  async #resolveTarget(
    container: Container,
    useLatestVersion: boolean,
    targets: Map<string, Promise<AppLaunchTarget>>,
  ): Promise<RolloutCatalogSnapshot> {
    if (!useLatestVersion) {
      if (!container.imageReference) throw new UpgradeRolloutConflictError("app_version_not_ready");
      return {
        appVersionId: container.appVersionId ?? null,
        imageArtifactId: container.imageArtifactId ?? null,
        imageReference: container.imageReference,
        runtimeContract: null,
      };
    }
    let pendingTarget = targets.get(container.appId);
    if (!pendingTarget) {
      pendingTarget = this.#source.getLaunchTarget(container.appId);
      targets.set(container.appId, pendingTarget);
    }
    const target = await pendingTarget;
    return {
      appVersionId: target.version.id,
      imageArtifactId: target.version.imageArtifactId ?? null,
      imageReference: target.imageReference,
      runtimeContract: target.version.runtimeContract ?? null,
    };
  }

  #newRollout(
    input: CreateUpgradeRolloutInput & { taskKind: UpgradeRolloutTaskKind },
    requested: number,
    metadata: {
      id: string;
      idempotencyKey: string | null;
      requestFingerprint: string;
      createdAt: string;
    },
  ): UpgradeRollout {
    return {
      id: metadata.id,
      revision: 1,
      actorUserId: input.actorUserId,
      status: "running",
      taskKind: input.taskKind,
      useLatestVersion: input.useLatestVersion,
      requested,
      completed: 0,
      succeeded: 0,
      failed: 0,
      waiting: 0,
      upgrading: requested,
      needsAttention: 0,
      idempotencyKey: metadata.idempotencyKey,
      requestFingerprint: metadata.requestFingerprint,
      createdAt: metadata.createdAt,
      updatedAt: metadata.createdAt,
      finishedAt: null,
    };
  }

  async #createRollout(
    rollout: UpgradeRollout,
    items: UpgradeRolloutItem[],
  ): Promise<UpgradeRolloutDetail> {
    return this.#store.createRollout(rollout, items);
  }

  get(id: string): Promise<UpgradeRolloutDetail | null> {
    return this.#store.getRollout(id);
  }

  /**
   * 通过领域服务读取单项，避免控制器直接依赖批次存储结构。
   * 批次或实例不存在时统一返回 null，由 HTTP 层映射为 404。
   */
  async getItem(rolloutId: string, instanceId: string): Promise<UpgradeRolloutItem | null> {
    const detail = await this.#store.getRollout(rolloutId);
    return detail?.items.find((item) => item.instanceId === instanceId) ?? null;
  }

  list(limit = 100): Promise<UpgradeRollout[]> {
    return this.#store.listRollouts(limit);
  }

  async force(rolloutId: string, instanceId: string): Promise<UpgradeRolloutDetail> {
    return this.#updateItem(rolloutId, instanceId, (item, now) => ({
      ...item,
      status: "queued",
      forceRequested: true,
      attemptId: null,
      // 人工介入重新开始失败预算；否则从 needs_attention 恢复的 item
      // 在第一次后续失败时就会再次进入终态。
      attemptCount: 0,
      blocker: null,
      error: null,
      nextAttemptAt: now,
      finishedAt: null,
    }));
  }

  async continueWaiting(rolloutId: string, instanceId: string): Promise<UpgradeRolloutDetail> {
    return this.#updateItem(rolloutId, instanceId, (item, now) => ({
      ...item,
      status: "queued",
      forceRequested: false,
      attemptId: null,
      attemptCount: 0,
      blocker: null,
      error: null,
      nextAttemptAt: now,
      finishedAt: null,
    }));
  }

  /**
   * Re-open a historical image deployment whose Runtime transaction proof was
   * lost during a Portal upgrade. This deliberately does not queue a rebuild;
   * the worker only re-checks the current candidate and its health state.
   */
  async revalidateFirstStart(rolloutId: string, instanceId: string): Promise<UpgradeRolloutDetail> {
    for (let attempt = 0; attempt < STORE_CAS_RETRY_LIMIT; attempt += 1) {
      const detail = await this.#store.getRollout(rolloutId);
      if (!detail) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
      if (detail.rollout.taskKind !== "image_upgrade") {
        throw new UpgradeRolloutConflictError("upgrade_rollout_item_not_revalidatable");
      }
      const item = detail.items.find((candidate) => candidate.instanceId === instanceId);
      if (!item) throw new UpgradeRolloutConflictError("upgrade_rollout_item_not_found");
      if (item.status !== "needs_attention" || item.blocker !== "candidate_first_start_proof_missing") {
        throw new UpgradeRolloutConflictError("upgrade_rollout_item_not_revalidatable");
      }
      const instance = await this.#source.getContainer(instanceId);
      if (!instance || !matchesCatalogTarget(instance, item)
        || (instance.status !== "running"
          && !(item.desiredState === "stopped" && instance.status === "stopped"))) {
        throw new UpgradeRolloutConflictError("candidate_first_start_not_revalidatable");
      }
      const now = this.#now().toISOString();
      const saved = await this.#store.compareAndSaveItem({
        ...item,
        ...firstStartRevalidationPatch(now, this.#randomId()),
      }, item.revision);
      if (!saved) continue;
      const refreshed = await refreshRolloutSummary(this.#store, rolloutId, this.#now);
      if (!refreshed) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
      return refreshed;
    }
    throw new UpgradeRolloutConflictError("upgrade_rollout_item_conflict");
  }

  async cancel(rolloutId: string, instanceId: string): Promise<UpgradeRolloutDetail> {
    return this.#updateItem(rolloutId, instanceId, (item, now) => ({
      ...item,
      status: "cancelled",
      blocker: null,
      error: null,
      attemptId: null,
      nextAttemptAt: null,
      finishedAt: now,
    }));
  }

  async #updateItem(
    rolloutId: string,
    instanceId: string,
    update: (item: UpgradeRolloutItem, now: string) => UpgradeRolloutItem,
  ): Promise<UpgradeRolloutDetail> {
    for (let attempt = 0; attempt < STORE_CAS_RETRY_LIMIT; attempt += 1) {
      const detail = await this.#store.getRollout(rolloutId);
      if (!detail) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
      const item = detail.items.find((candidate) => candidate.instanceId === instanceId);
      if (!item) throw new UpgradeRolloutConflictError("upgrade_rollout_item_not_found");
      if (!actionableItem(item.status)) throw new UpgradeRolloutConflictError("upgrade_rollout_item_not_actionable");
      const now = this.#now().toISOString();
      const saved = await this.#store.compareAndSaveItem({
        ...update(item, now),
        updatedAt: now,
      }, item.revision);
      if (!saved) continue;
      const refreshed = await refreshRolloutSummary(this.#store, rolloutId, this.#now);
      if (!refreshed) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
      return refreshed;
    }
    throw new UpgradeRolloutConflictError("upgrade_rollout_item_conflict");
  }
}

export class UpgradeRolloutWorker {
  readonly #store: UpgradeRolloutStore;
  readonly #source: Pick<UpgradeRolloutSource, "getContainer">;
  readonly #activity: UpgradeActivityPolicy;
  readonly #executor: UpgradeExecutor;
  readonly #withLease: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T | null>;
  readonly #now: () => Date;
  readonly #retryDelayMs: number;
  readonly #batchSize: number;
  readonly #admission: UpgradeAdmission | undefined;
  readonly #withItemLease: <T>(instanceId: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T | null>;
  readonly #maxAttempts: number;
  readonly #maxRetryDelayMs: number;
  readonly #randomId: () => string;
  readonly #checkpointRolloutIds = new Set<string>();
  #legacyFirstStartProofsReconciled = false;

  constructor(options: {
    store: UpgradeRolloutStore;
    source: Pick<UpgradeRolloutSource, "getContainer">;
    activity: UpgradeActivityPolicy;
    executor: UpgradeExecutor;
    withLease: <T>(operation: (signal: AbortSignal) => Promise<T>) => Promise<T | null>;
    now?: () => Date;
    retryDelayMs?: number;
    batchSize?: number;
    admission?: UpgradeAdmission;
    withItemLease?: <T>(instanceId: string, operation: (signal: AbortSignal) => Promise<T>) => Promise<T | null>;
    maxAttempts?: number;
    maxRetryDelayMs?: number;
    randomId?: () => string;
  }) {
    this.#store = options.store;
    this.#source = options.source;
    this.#activity = options.activity;
    this.#executor = options.executor;
    this.#withLease = options.withLease;
    this.#now = options.now ?? (() => new Date());
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#batchSize = options.batchSize ?? 100;
    this.#admission = options.admission;
    this.#withItemLease = options.withItemLease ?? (async (_instanceId, operation) => operation(new AbortController().signal));
    this.#maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_REBUILD_ATTEMPTS));
    this.#maxRetryDelayMs = Math.max(this.#retryDelayMs, options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
    this.#randomId = options.randomId ?? randomUUID;
  }

  async runOnce(): Promise<boolean> {
    const claimed = await this.#withLease(async (workerSignal) => {
      workerSignal.throwIfAborted();
      this.#checkpointRolloutIds.clear();
      const now = this.#now();
      // PostgreSQL advisory lock 的连接丢失不会中止已经发出的 Docker 命令。
      // 保留一个大于正常 rebuild 事务的失联窗口，避免新 Portal 立即恢复时
      // 和旧执行者形成双写；超过窗口后才把中断状态重新排队。
      await this.#store.recoverInterruptedItems(
        new Date(now.getTime() - INTERRUPTED_ATTEMPT_RECOVERY_GRACE_MS).toISOString(),
        now.toISOString(),
      );
      // 汇总写入与 item 状态变更跨进程存在短暂窗口；每轮先修复父批次，
      // 这样 Portal 在终态写入后立即崩溃也能在重启时继续调度或收敛。
      const rollouts = await this.#store.listRollouts(500);
      if (!this.#legacyFirstStartProofsReconciled) {
        this.#legacyFirstStartProofsReconciled = await this.#reconcileLegacyFirstStartProofs(
          rollouts,
          workerSignal,
        );
      }
      for (const rollout of rollouts) await this.#refreshRollout(rollout.id);
      const items = await this.#store.listDueItems(now.toISOString(), this.#batchSize);
      for (const item of items) {
        workerSignal.throwIfAborted();
        await this.#withItemLease(item.instanceId, (itemSignal) => (
          this.#processItem(item, AbortSignal.any([workerSignal, itemSignal]))
        ));
      }
      workerSignal.throwIfAborted();
      const touchedRolloutIds = new Set(items.map((item) => item.rolloutId));
      for (const rolloutId of this.#checkpointRolloutIds) touchedRolloutIds.add(rolloutId);
      for (const rolloutId of touchedRolloutIds) await this.#refreshRollout(rolloutId);
      return items.length > 0;
    });
    return claimed ?? false;
  }

  async #reconcileLegacyFirstStartProofs(
    rollouts: readonly UpgradeRollout[],
    workerSignal: AbortSignal,
  ): Promise<boolean> {
    let complete = true;
    const candidates = this.#store.listLegacyFirstStartProofItems
      ? await this.#store.listLegacyFirstStartProofItems()
      : await this.#legacyFirstStartProofItemsFromRollouts(rollouts);
    for (const candidate of candidates) {
      workerSignal.throwIfAborted();
      const reconciled = await this.#withItemLease(candidate.instanceId, async (itemSignal) => {
        const signal = AbortSignal.any([workerSignal, itemSignal]);
        signal.throwIfAborted();
        const latestDetail = await this.#store.getRollout(candidate.rolloutId);
        const latest = latestDetail?.items.find((item) => item.instanceId === candidate.instanceId);
        if (!latest) return true;
        if (latest.status !== "needs_attention" || latest.blocker !== "candidate_first_start_proof_missing") return true;
        // The direct scan may have raced a metadata-only write. Keep scanning
        // while the item is still the same proof-missing state; otherwise a
        // one-shot startup pass could strand it until the next Portal restart.
        if (latest.revision !== candidate.revision) return false;
        try {
          const instance = await this.#source.getContainer(candidate.instanceId);
          signal.throwIfAborted();
          if (!instance || !matchesCatalogTarget(instance, latest)) return true;
          if (instance.status === "running") {
            await this.#succeed(latest, true);
            return true;
          }
          if (latest.desiredState !== "stopped" || instance.status !== "stopped") return true;
          const now = this.#now().toISOString();
          await this.#transition(latest, {
            ...firstStartRevalidationPatch(now, this.#randomId()),
          });
          this.#checkpointRolloutIds.add(candidate.rolloutId);
          return true;
        } catch (error) {
          if (error instanceof UpgradeRolloutConflictError) {
            // A concurrent writer may have changed an unrelated snapshot field
            // while leaving the legacy proof blocker in place. Keep the one-shot
            // startup scan open in that case so the next maintenance cycle can
            // retry; only a terminal or differently blocked item is complete.
            const currentDetail = await this.#store.getRollout(candidate.rolloutId);
            const current = currentDetail?.items.find((item) => item.instanceId === candidate.instanceId);
            return !(current
              && current.status === "needs_attention"
              && current.blocker === "candidate_first_start_proof_missing");
          }
          throw error;
        }
      });
      if (reconciled === null || reconciled === false) complete = false;
    }
    return complete;
  }

  async #legacyFirstStartProofItemsFromRollouts(
    rollouts: readonly UpgradeRollout[],
  ): Promise<UpgradeRolloutItem[]> {
    const items: UpgradeRolloutItem[] = [];
    for (const rollout of rollouts) {
      if (rollout.taskKind !== "image_upgrade") continue;
      const detail = await this.#store.getRollout(rollout.id);
      items.push(...(detail?.items.filter((item) => (
        item.status === "needs_attention"
        && item.blocker === "candidate_first_start_proof_missing"
      )) ?? []));
    }
    return items;
  }

  async #processItem(initial: UpgradeRolloutItem, signal: AbortSignal): Promise<void> {
    const latestRollout = await this.#store.getRollout(initial.rolloutId);
    const latest = latestRollout?.items.find((item) => item.instanceId === initial.instanceId);
    if (!latest || latest.revision !== initial.revision || terminalItem(latest.status)) return;
    initial = latest;
    const reconcilingFirstStart = initial.status === "awaiting_first_start";
    const attemptId = reconcilingFirstStart ? initial.attemptId : this.#randomId();
    let drainAcquired = false;
    try {
      signal.throwIfAborted();
      if (reconcilingFirstStart) {
        if (!attemptId) throw new Error("upgrade_rollout_attempt_missing");
        const rollout = await this.#store.getRollout(initial.rolloutId);
        if (!rollout) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
        await this.#reconcileFirstStart(initial, rollout.rollout.taskKind, signal);
        return;
      }
      if (!attemptId) throw new Error("upgrade_rollout_attempt_missing");
      const rollout = await this.#store.getRollout(initial.rolloutId);
      if (!rollout) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
      const prepared = await this.#prepareAttempt(initial, rollout.rollout.taskKind, attemptId, signal);
      if (!prepared) return;
      const admission = await this.#acquireAdmission(prepared.item, attemptId, signal);
      if (admission === null) return;
      drainAcquired = admission;
      const drainingItem = await this.#transition(prepared.item, { status: "draining", blocker: null });
      if (!(await this.#confirmDrain(drainingItem, prepared.instance, drainAcquired, signal))) return;
      await this.#rebuildAndVerify(drainingItem, signal);
    } catch (error) {
      // Lease 失联后 Docker 的最终状态可能尚未收敛。旧执行者不得把 item
      // 立即重新排队；保留中断态，由带 grace 的恢复流程统一接管。
      if (signal.aborted) return;
      if (error instanceof UpgradeRolloutConflictError) return;
      const latest = await this.#store.getRollout(initial.rolloutId);
      const current = latest?.items.find((candidate) => candidate.instanceId === initial.instanceId);
      if (!current || terminalItem(current.status)) return;
      await this.#handleFailure(current, error, signal);
    } finally {
      // clear 按 rolloutId 校验所有权；即使本轮只走了已升级快速路径，
      // 也要清掉上次进程崩溃遗留的同批次 fence。lease 失联时则保留本代次
      // drain，直到带 grace 的恢复事务同时接管 item 与 fence。
      if (this.#admission && drainAcquired && attemptId && !signal.aborted) {
        await this.#admission.clear(initial.instanceId, initial.rolloutId, attemptId);
      }
    }
  }

  async #prepareAttempt(
    initial: UpgradeRolloutItem,
    taskKind: UpgradeRolloutTaskKind,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<{ item: UpgradeRolloutItem; instance: Container } | null> {
    const checkedAt = this.#now().toISOString();
    let item = await this.#transition(initial, {
      status: "assessing",
      blocker: null,
      error: null,
      attemptId,
      nextAttemptAt: null,
      lastCheckedAt: checkedAt,
      startedAt: initial.startedAt ?? checkedAt,
    });
    signal.throwIfAborted();
    const instance = await this.#source.getContainer(item.instanceId);
    signal.throwIfAborted();
    if (!instance) throw new Error("container_not_found");
    item = await this.#captureExecutionSnapshot(item, instance);
    if (taskKind === "image_upgrade" && matchesTarget(instance, item)) {
      await this.#succeed(item);
      return null;
    }
    if (instance.status === "creating") {
      await this.#waitForIdle(item, "instance_creating");
      return null;
    }
    const assessment = item.forceRequested || instance.status !== "running"
      ? { ready: true }
      : await this.#activity.assess(instance, item);
    signal.throwIfAborted();
    if (!assessment.ready) {
      await this.#waitForIdle(item, assessment.reason ?? "instance_busy");
      return null;
    }
    return { item, instance };
  }

  async #acquireAdmission(
    item: UpgradeRolloutItem,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<boolean | null> {
    if (!this.#admission) return false;
    const admitted = await this.#admission.begin(
      item.instanceId,
      item.rolloutId,
      attemptId,
      item.forceRequested ? "force" : "graceful",
    );
    signal.throwIfAborted();
    if (admitted) return true;
    await this.#waitForIdle(item, "active_connection");
    return null;
  }

  async #confirmDrain(
    item: UpgradeRolloutItem,
    instance: Container,
    drainAcquired: boolean,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (!drainAcquired || item.forceRequested || instance.status !== "running") return true;
    // drain 与首次判定之间仍可能完成一个请求。必须重新读取持久化活动
    // 下界，并通过独立复核 seam 检查 Docker 累计指标，不能复用旧快照。
    const drainedInstance = await this.#source.getContainer(item.instanceId);
    signal.throwIfAborted();
    if (!drainedInstance) throw new Error("container_not_found");
    const confirmation = this.#activity.confirmAfterDrain
      ? await this.#activity.confirmAfterDrain(drainedInstance, item)
      : await this.#activity.assess(drainedInstance, item);
    signal.throwIfAborted();
    if (confirmation.ready) return true;
    await this.#waitForIdle(item, confirmation.reason ?? "instance_busy_after_drain");
    return false;
  }

  async #rebuildAndVerify(item: UpgradeRolloutItem, signal: AbortSignal): Promise<void> {
    item = await this.#transition(item, { status: "rebuilding" });
    const rollout = await this.#store.getRollout(item.rolloutId);
    if (!rollout) throw new UpgradeRolloutConflictError("upgrade_rollout_not_found");
    signal.throwIfAborted();
    // Every rebuild task advances the instance's deployment baseline. Keep
    // image, same-image, and resource-policy rebuilds on the same reconciliation
    // path so an older deferred candidate cannot block a later task.
    if (this.#executor.acceptDeferredCandidate) {
      const accepted = await this.#executor.acceptDeferredCandidate(item, signal);
      signal.throwIfAborted();
      if (accepted) {
        const affectedRolloutIds = await this.#store.supersedeDeferredItemsBefore(
          item.rolloutId,
          item.instanceId,
          this.#now().toISOString(),
        );
        for (const rolloutId of affectedRolloutIds) this.#checkpointRolloutIds.add(rolloutId);
      }
    }
    await this.#executor.rebuild(item, rollout.rollout.actorUserId, signal);
    signal.throwIfAborted();
    item = await this.#transition(item, { status: "verifying" });
    const verified = await this.#source.getContainer(item.instanceId);
    signal.throwIfAborted();
    if (!verified || !matchesCatalogTarget(verified, item)) throw new Error("upgrade_verification_failed");
    if (item.desiredState === "stopped" && verified.status === "stopped") {
      await this.#commitDeploymentCheckpoint(item, "awaiting_first_start", true);
      return;
    }
    if (!matchesTarget(verified, item)) throw new Error("upgrade_verification_failed");
    await this.#succeed(item, true);
  }

  async #waitForIdle(item: UpgradeRolloutItem, blocker: string): Promise<void> {
    await this.#transition(item, {
      status: "waiting_for_idle",
      blocker,
      attemptId: null,
      nextAttemptAt: this.#nextAttemptAt(item.attemptCount),
    });
  }

  async #reconcileFirstStart(
    item: UpgradeRolloutItem,
    taskKind: UpgradeRolloutTaskKind,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const inspection = this.#executor.inspectRebuild
      ? await this.#executor.inspectRebuild(item, signal)
      : null;
    signal.throwIfAborted();
    const instance = await this.#source.getContainer(item.instanceId);
    signal.throwIfAborted();
    if (!instance) throw new Error("container_not_found");
    if (inspection?.status === "inconsistent") {
      throw new Error("candidate_first_start_inconsistent");
    }
    if (inspection?.status === "committed") {
      if (!matchesCatalogTarget(instance, item)) {
        throw new Error("candidate_first_start_inconsistent");
      }
      await this.#succeed(item, true);
      return;
    }
    if (inspection?.status === "not_found") {
      if (!matchesCatalogTarget(instance, item)) {
        throw new Error("candidate_first_start_rolled_back");
      }
      if (taskKind === "image_upgrade" && instance.status === "running") {
        await this.#succeed(item, true);
        return;
      }
      if (taskKind === "image_upgrade" && item.desiredState === "stopped" && instance.status === "stopped") {
        await this.#deferFirstStart(item);
        return;
      }
      throw new Error("candidate_first_start_proof_missing");
    }
    if (inspection?.status === "pending") {
      if (!matchesCatalogTarget(instance, item)) {
        throw new Error("candidate_first_start_inconsistent");
      }
      await this.#deferFirstStart(item);
      return;
    }
    if (!matchesCatalogTarget(instance, item)) throw new Error("candidate_first_start_rolled_back");
    // A missing inspection is only a legacy image-upgrade compatibility path.
    // Same-image and resource-policy rebuilds must retain Runtime transaction proof.
    if (taskKind !== "image_upgrade" || item.desiredState !== "stopped") {
      throw new Error("candidate_first_start_proof_missing");
    }
    if (instance.status === "running") {
      await this.#succeed(item, true);
      return;
    }
    if (instance.status !== "stopped") throw new Error("candidate_first_start_unhealthy");
    await this.#deferFirstStart(item);
  }

  async #deferFirstStart(item: UpgradeRolloutItem): Promise<void> {
    await this.#transition(item, {
      blocker: "candidate_awaiting_first_healthy_start",
      error: null,
      nextAttemptAt: this.#nextAttemptAt(item.attemptCount),
      lastCheckedAt: this.#now().toISOString(),
    });
  }

  async #captureExecutionSnapshot(
    item: UpgradeRolloutItem,
    instance: Container,
  ): Promise<UpgradeRolloutItem> {
    const desiredState = item.recovery
      ? "running"
      : instance.status === "running" || instance.status === "creating"
        ? "running"
        : "stopped";
    const sourceAppVersionId = instance.appVersionId ?? null;
    const sourceImageArtifactId = instance.imageArtifactId ?? null;
    const sourceImageReference = instance.imageReference ?? null;
    if (item.desiredState === desiredState
      && item.sourceAppVersionId === sourceAppVersionId
      && item.sourceImageArtifactId === sourceImageArtifactId
      && item.sourceImageReference === sourceImageReference) return item;
    return this.#transition(item, {
      desiredState,
      sourceAppVersionId,
      sourceImageArtifactId,
      sourceImageReference,
    });
  }

  async #handleFailure(item: UpgradeRolloutItem, error: unknown, signal: AbortSignal): Promise<void> {
    const message = errorMessage(error);
    const failureCount = item.attemptCount + 1;
    const maxAttempts = item.recovery ? 3 : this.#maxAttempts;
    let diagnostics: UpgradeRolloutDiagnostics | null = null;
    if (item.recovery && this.#executor.diagnose) {
      try {
        const result = await this.#executor.diagnose(item, signal);
        if (result.status === "unsupported") {
          diagnostics = {
            capturedAt: this.#now().toISOString(),
            error: sanitizeSensitiveText(message),
            capabilityStatus: "unsupported",
          };
        } else {
          if (result.status === "unavailable") throw result.error;
          const captured = result.value;
          diagnostics = {
            capturedAt: this.#now().toISOString(),
            error: sanitizeSensitiveText(message),
            capabilityStatus: "supported",
            containerRole: captured.containerRole,
            exitCode: captured.exitCode,
            oomKilled: captured.oomKilled,
            health: captured.health ? sanitizeSensitiveText(captured.health, 120) : null,
            memoryLimit: captured.memoryLimit ? sanitizeSensitiveText(captured.memoryLimit, 120) : null,
            memorySwapLimit: captured.memorySwapLimit ? sanitizeSensitiveText(captured.memorySwapLimit, 120) : null,
            cpus: captured.cpus ? sanitizeSensitiveText(captured.cpus, 120) : null,
            pidsLimit: captured.pidsLimit,
            logTail: captured.logTail ? sanitizeSensitiveText(captured.logTail, 16_000) : null,
          };
        }
      } catch (diagnosticError) {
        if (signal.aborted) return;
        diagnostics = {
          capturedAt: this.#now().toISOString(),
          error: sanitizeSensitiveText(message),
          capabilityStatus: "unavailable",
          logTail: sanitizeSensitiveText(`diagnostics_unavailable: ${errorMessage(diagnosticError)}`, 2_000),
        };
      }
    }
    const providerRequiresAttention = error instanceof ProviderOperationError
      && (error.failureClass === "permanent" || error.failureClass === "inconsistent");
    const permanent = providerRequiresAttention
      || message === "container_not_found"
      || message === "app_version_not_ready"
      || message === "upgrade_rollout_attempt_missing"
      || message === "candidate_first_start_inconsistent"
      || message === "candidate_first_start_proof_missing";
    if (permanent || failureCount >= maxAttempts) {
      const needsAttention = permanent || Boolean(item.recovery);
      await this.#transition(item, {
        status: needsAttention ? "needs_attention" : "failed",
        error: message,
        blocker: permanent ? message : "retry_limit_reached",
        attemptId: null,
        attemptCount: failureCount,
        nextAttemptAt: null,
        finishedAt: this.#now().toISOString(),
        diagnostics,
      }).catch((transitionError) => {
        if (!(transitionError instanceof UpgradeRolloutConflictError)) throw transitionError;
      });
      return;
    }
    await this.#transition(item, {
      status: "queued",
      error: message,
      blocker: "retry_scheduled",
      attemptId: null,
      attemptCount: failureCount,
      nextAttemptAt: this.#nextAttemptAt(failureCount),
      diagnostics,
    }).catch((transitionError) => {
      if (!(transitionError instanceof UpgradeRolloutConflictError)) throw transitionError;
    });
  }

  #nextAttemptAt(attemptCount: number): string {
    const delay = Math.min(this.#maxRetryDelayMs, this.#retryDelayMs * (2 ** Math.max(0, attemptCount - 1)));
    return new Date(this.#now().getTime() + delay).toISOString();
  }

  async #succeed(item: UpgradeRolloutItem, supersedeEarlier = true): Promise<void> {
    await this.#commitDeploymentCheckpoint(item, "succeeded", supersedeEarlier);
  }

  async #commitDeploymentCheckpoint(
    item: UpgradeRolloutItem,
    status: "awaiting_first_start" | "succeeded",
    supersedeEarlier: boolean,
  ): Promise<void> {
    const now = this.#now().toISOString();
    const checkpointItem: UpgradeRolloutItem = {
      ...item,
      status,
      blocker: status === "succeeded" ? null : "candidate_awaiting_first_healthy_start",
      error: null,
      attemptId: status === "succeeded" ? null : item.attemptId,
      finishedAt: status === "succeeded" ? now : null,
      nextAttemptAt: status === "succeeded" ? null : this.#nextAttemptAt(item.attemptCount),
      lastCheckedAt: now,
      updatedAt: now,
    };
    const checkpoint = await this.#store.commitDeploymentCheckpoint(
      checkpointItem,
      item.revision,
      now,
      supersedeEarlier,
    );
    if (!checkpoint) throw new UpgradeRolloutConflictError("upgrade_rollout_item_conflict");
    for (const rolloutId of checkpoint.affectedRolloutIds) this.#checkpointRolloutIds.add(rolloutId);
  }

  async #transition(
    item: UpgradeRolloutItem,
    patch: Partial<UpgradeRolloutItem>,
  ): Promise<UpgradeRolloutItem> {
    const expectedRevision = item.revision;
    const updated = await this.#store.compareAndSaveItem({
      ...item,
      ...patch,
      updatedAt: this.#now().toISOString(),
    }, expectedRevision);
    if (!updated) throw new UpgradeRolloutConflictError("upgrade_rollout_item_conflict");
    return updated;
  }

  async #refreshRollout(id: string): Promise<void> {
    await refreshRolloutSummary(this.#store, id, this.#now);
  }
}

export function upgradeInstanceLeaseName(instanceId: string): string {
  return `upgrade-instance:${instanceId}`;
}

async function refreshRolloutSummary(
  store: UpgradeRolloutStore,
  id: string,
  now: () => Date,
): Promise<UpgradeRolloutDetail | null> {
  for (let attempt = 0; attempt < STORE_CAS_RETRY_LIMIT; attempt += 1) {
    const detail = await store.getRollout(id);
    if (!detail) return null;
    const succeeded = detail.items.filter((item) => item.status === "succeeded").length;
    const failedItems = detail.items.filter((item) => item.status === "failed").length;
    const needsAttention = detail.items.filter((item) => item.status === "needs_attention").length;
    const cancelled = detail.items.filter((item) => item.status === "cancelled").length;
    const superseded = detail.items.filter((item) => item.status === "superseded").length;
    const completed = succeeded + superseded + failedItems + needsAttention + cancelled;
    const waiting = detail.items.filter((item) => (
      item.status === "waiting_for_idle" || item.status === "awaiting_first_start"
    )).length;
    const upgrading = detail.items.length - completed - waiting;
    const terminal = completed === detail.items.length;
    const status: UpgradeRolloutStatus = terminal
      ? needsAttention > 0
        ? "needs_attention"
        : failedItems > 0
          ? "partial_failed"
          : cancelled > 0
            ? "cancelled"
            : "succeeded"
      : "running";
    const updatedAt = now().toISOString();
    const finishedAt = terminal ? detail.rollout.finishedAt ?? updatedAt : null;
    const unchanged = detail.rollout.status === status
      && detail.rollout.completed === completed
      && detail.rollout.succeeded === succeeded
      && (detail.rollout.superseded ?? 0) === superseded
      && detail.rollout.failed === failedItems
      && detail.rollout.waiting === waiting
      && detail.rollout.upgrading === upgrading
      && detail.rollout.needsAttention === needsAttention
      && detail.rollout.finishedAt === finishedAt;
    if (unchanged) return detail;
    const saved = await store.compareAndSaveRollout({
      ...detail.rollout,
      status,
      completed,
      succeeded,
      superseded,
      failed: failedItems,
      waiting,
      upgrading,
      needsAttention,
      updatedAt,
      finishedAt,
    }, detail.rollout.revision);
    if (saved) return store.getRollout(id);
  }
  throw new UpgradeRolloutConflictError("upgrade_rollout_summary_conflict");
}

function uniqueInstanceIds(values: string[]): string[] {
  const normalized = [...new Set(values.map((value) => {
    if (typeof value !== "string") throw new UpgradeRolloutConflictError("invalid_upgrade_rollout_instances");
    return value.trim();
  }).filter(Boolean))];
  if (normalized.length === 0 || normalized.length > MAX_ROLLOUT_INSTANCES) {
    throw new UpgradeRolloutConflictError("invalid_upgrade_rollout_instances");
  }
  return normalized;
}

function normalizeIdempotencyKey(value: string | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized ? normalized : null;
}

function matchesTarget(instance: Container, item: UpgradeRolloutItem): boolean {
  return matchesCatalogTarget(instance, item)
    && (item.desiredState === "running" ? instance.status === "running" : instance.status === "stopped");
}

function matchesCatalogTarget(instance: Container, item: UpgradeRolloutItem): boolean {
  return instance.appVersionId === item.targetAppVersionId
    // 历史实例可能没有 artifact id，因此 target 为空时保留兼容分支；一旦
    // 批次捕获了不可变 artifact 身份，仅比较引用不能证明升级已经完成。
    && (item.targetImageArtifactId === null || instance.imageArtifactId === item.targetImageArtifactId)
    && instance.imageReference === item.targetImageReference;
}

function firstStartRevalidationPatch(now: string, attemptId: string): Partial<UpgradeRolloutItem> {
  return {
    status: "awaiting_first_start",
    blocker: "candidate_awaiting_first_healthy_start",
    error: null,
    diagnostics: null,
    forceRequested: false,
    attemptId,
    attemptCount: 0,
    nextAttemptAt: now,
    lastCheckedAt: now,
    finishedAt: null,
    updatedAt: now,
  };
}

function terminalItem(status: UpgradeRolloutItemStatus): boolean {
  return status === "succeeded" || status === "superseded" || status === "failed" || status === "cancelled" || status === "needs_attention";
}

function actionableItem(status: UpgradeRolloutItemStatus): boolean {
  return status === "queued" || status === "waiting_for_idle" || status === "failed" || status === "needs_attention";
}

function errorMessage(error: unknown): string {
  return sanitizeSensitiveText(error instanceof Error ? error.message : String(error), 2_000);
}
