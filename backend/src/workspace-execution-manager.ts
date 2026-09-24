import { createHash, randomUUID } from "node:crypto";

import type {
  ExecutionControlPort,
  ExecutionEnvironmentRemovalRequest,
  ExecutionObservationRequest,
  ExecutionReconcileRequest,
  ExecutionReconcileResult,
  ExecutionTransactionInspection,
  ExecutionTransactionPort,
  ProviderExecution,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort,
} from "./execution-provider.js";
import { ProviderOperationError } from "./execution-provider.js";
import type { Container } from "./models.js";
import type { ContainerCatalogSnapshot, ContainerLaunchProfile, StorageBinding } from "./runtime.js";
import type {
  WorkspaceDeletionPhase,
  WorkspaceExecutionProjection,
} from "./workspace-execution.js";
import { projectWorkspaceExecutionToContainer } from "./workspace-execution-model.js";
import { workspaceStorageRef } from "./workspace-execution.js";

const MAX_CAS_ATTEMPTS = 8;

export interface WorkspaceExecutionStore {
  getWorkspaceExecutionProjection(id: string): Promise<WorkspaceExecutionProjection | null>;
  compareAndSaveWorkspaceExecution(
    projection: WorkspaceExecutionProjection,
    expectedRevision: number,
  ): Promise<WorkspaceExecutionProjection | null>;
  countLiveWorkspaceStorageReferences(storageRefId: string, excludingWorkspaceId: string): Promise<number>;
}

export interface WorkspaceDeletionDrainPort {
  begin(workspaceId: string, transactionId: string, signal?: AbortSignal): Promise<boolean>;
  clear(workspaceId: string, transactionId: string): Promise<void>;
}

export interface WorkspaceDeletionInput {
  workspaceId: string;
  transactionKey?: string;
  signal?: AbortSignal;
}

export interface WorkspaceExecutionReconcileInput {
  workspaceId: string;
  ownerId: string;
  /** Existing Workspaces keep their persisted Provider pin; new callers may select one explicitly. */
  providerId?: string;
  /** Optional code-owned artifact kind used for Provider capability checks. */
  artifactKind?: string;
  /** Optional App/Revision execution contract used for Provider capability checks. */
  executionContract?: string | null;
  /** Optional storage class override supplied by a trusted control-plane caller. */
  storageClass?: string;
  appId: string;
  appRevisionId: string | null;
  launchArtifactId: string | null;
  launchArtifactReference: string;
  sourceCatalogSnapshot?: ContainerCatalogSnapshot;
  launchProfile: ContainerLaunchProfile;
  desiredState: "running" | "stopped";
  replace: boolean;
  transactionKey?: string;
  signal?: AbortSignal;
}

export class WorkspaceExecutionStateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * generation、transaction 和 Execution revision 只在此模块分配并提交。Provider 只执行
 * 已持久化的期望状态，因此进程中止后仍能用同一 transaction 安全对账。
 */
export class WorkspaceExecutionManager {
  readonly #store: WorkspaceExecutionStore;
  readonly #provider: ExecutionControlPort;
  readonly #storageBindingResolver: WorkspaceStorageBindingResolver;
  readonly #storageReleaser: WorkspaceStorageReleasePort;
  readonly #deletionDrain: WorkspaceDeletionDrainPort;
  readonly #transactions: ExecutionTransactionPort | null;
  readonly #now: () => Date;
  readonly #randomId: () => string;

  constructor(options: {
    store: WorkspaceExecutionStore;
    provider: ExecutionControlPort;
    storageBindingResolver: WorkspaceStorageBindingResolver;
    storageReleaser: WorkspaceStorageReleasePort;
    deletionDrain: WorkspaceDeletionDrainPort;
    transactions?: ExecutionTransactionPort;
    now?: () => Date;
    randomId?: () => string;
  }) {
    this.#store = options.store;
    this.#provider = options.provider;
    this.#storageBindingResolver = options.storageBindingResolver;
    this.#storageReleaser = options.storageReleaser;
    this.#deletionDrain = options.deletionDrain;
    if (this.#storageReleaser.providerId !== this.#provider.providerId) {
      throw new WorkspaceExecutionStateError("workspace_storage_release_provider_mismatch");
    }
    this.#transactions = options.transactions ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  async getProjection(workspaceId: string): Promise<WorkspaceExecutionProjection> {
    const projection = await this.#store.getWorkspaceExecutionProjection(workspaceId);
    if (!projection) throw new WorkspaceExecutionStateError("workspace_not_found");
    return projection;
  }

  async inspect(workspaceId: string, signal?: AbortSignal): Promise<ProviderExecution | null> {
    const projection = await this.getProjection(workspaceId);
    this.#assertActive(projection);
    return this.#provider.inspect(workspaceId, signal, projection.execution.providerId);
  }

  async observe(workspaceId: string, signal?: AbortSignal): Promise<ProviderExecution | null> {
    const projection = await this.getProjection(workspaceId);
    this.#assertActive(projection);
    const storageBinding = await this.#resolveStorageBinding(projection, signal);
    const request: ExecutionObservationRequest = {
      workspaceId,
      expectedOwnerId: projection.workspace.ownerId,
      ...providerRouteFields(this.#provider, projection.execution.providerId),
      storageBindings: [storageBinding],
      ...(signal ? { signal } : {}),
    };
    return this.#provider.observe(request);
  }

  async reconcile(input: WorkspaceExecutionReconcileInput): Promise<WorkspaceExecutionProjection> {
    input.signal?.throwIfAborted();
    if (input.launchProfile.imageReference !== input.launchArtifactReference) {
      throw new WorkspaceExecutionStateError("launch_artifact_profile_mismatch");
    }
    const current = await this.getProjection(input.workspaceId);
    this.#assertActive(current);
    const expectedStorageClass = workspaceStorageRef(current.workspace, current.execution.providerId).storageClass;
    if (input.storageClass !== undefined && input.storageClass !== expectedStorageClass) {
      throw new WorkspaceExecutionStateError("workspace_storage_class_mismatch");
    }
    const transactionId = input.transactionKey
      ? executionTransactionId(input.workspaceId, input.transactionKey)
      : this.#randomId();
    const intent = await this.#persistIntent(input, transactionId);
    if (completedTransaction(intent, input, transactionId)) return intent;

    try {
      const storageBinding = await this.#resolveStorageBinding(intent, input.signal);
      const request: ExecutionReconcileRequest = {
        workspaceId: input.workspaceId,
        ownerId: input.ownerId,
        ...providerRouteFields(this.#provider, intent.execution.providerId),
        ...(input.artifactKind === undefined ? {} : { artifactKind: input.artifactKind }),
        ...(input.executionContract === undefined ? {} : { executionContract: input.executionContract }),
        ...(input.storageClass === undefined ? {} : { storageClass: input.storageClass }),
        appId: input.appId,
        appRevisionId: input.appRevisionId,
        launchArtifactId: input.launchArtifactId,
        launchArtifactReference: input.launchArtifactReference,
        ...(input.sourceCatalogSnapshot ? { sourceCatalogSnapshot: input.sourceCatalogSnapshot } : {}),
        launchProfile: structuredClone(input.launchProfile),
        storageBindings: [structuredClone(storageBinding)],
        desiredState: input.desiredState,
        desiredGeneration: intent.execution.desiredGeneration,
        transactionId,
        replace: input.replace,
        ...(input.signal ? { signal: input.signal } : {}),
      };
      const result = await this.#provider.reconcile(request);
      input.signal?.throwIfAborted();
      return await this.#commitResult(input, result);
    } catch (error) {
      if (!(error instanceof ProviderOperationError) || error.failureClass !== "cancelled") {
        await this.#recordProviderFailure(input.workspaceId, transactionId, error);
      }
      throw error;
    }
  }

  async persistLegacyContainer(container: Container): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.getProjection(container.id);
      this.#assertActive(current);
      const previous = projectWorkspaceExecutionToContainer(current);
      assertLegacyIdentity(previous, container);
      if (sameLegacyContainer(previous, container)) return;
      const updatedAt = container.updatedAt;
      const inFlight = current.execution.transactionStatus === "requested"
        || current.execution.transactionStatus === "progressing";
      const next = structuredClone(current);
      next.workspace.appRevisionId = container.appVersionId ?? null;
      next.workspace.updatedAt = updatedAt;
      next.execution.environmentRef = container.runtimeId === "pending" ? null : container.runtimeId;
      next.execution.observedState = container.status;
      next.execution.launchArtifactId = container.imageArtifactId ?? null;
      next.execution.launchArtifactReference = container.imageReference ?? null;
      next.execution.legacyEndpoint = container.endpoint;
      next.execution.stopReason = container.stopReason;
      next.execution.lastActivityAt = latestTimestamp(current.execution.lastActivityAt, container.lastActivityAt);
      next.execution.updatedAt = updatedAt;
      if (!inFlight) {
        next.execution.desiredAppRevisionId = container.appVersionId ?? null;
        next.execution.desiredLaunchArtifactId = container.imageArtifactId ?? null;
        next.execution.desiredLaunchArtifactReference = container.imageReference ?? null;
        next.execution.desiredState = container.status === "stopped" ? "stopped" : "running";
      }
      if (container.status === "running") {
        next.execution.healthyGeneration = Math.max(
          next.execution.healthyGeneration ?? 0,
          next.execution.deployedGeneration,
        );
      }
      next.compatibility.runtimeId = container.runtimeId;
      next.compatibility.status = container.status;
      if (await this.#store.compareAndSaveWorkspaceExecution(next, current.execution.revision)) return;
    }
    throw new WorkspaceExecutionStateError("workspace_execution_state_conflict");
  }

  async acceptDeferredExecution(workspaceId: string, ownerId: string, signal?: AbortSignal) {
    const projection = await this.getProjection(workspaceId);
    this.#assertActive(projection);
    if (!this.#transactions) return "not_found" as const;
    return this.#transactions.acceptDeferredExecution(
      workspaceId,
      ownerId,
      signal,
      legacyProviderArgument(this.#transactions, projection.execution.providerId),
    );
  }

  async inspectTransaction(
    workspaceId: string,
    transactionKey: string,
    signal?: AbortSignal,
  ): Promise<ExecutionTransactionInspection | null> {
    const projection = await this.getProjection(workspaceId);
    this.#assertActive(projection);
    if (!this.#transactions) return null;
    return this.#transactions.inspectTransaction(
      workspaceId,
      executionTransactionId(workspaceId, transactionKey),
      signal,
      legacyProviderArgument(this.#transactions, projection.execution.providerId),
    );
  }

  async removeEnvironment(workspaceId: string, signal?: AbortSignal): Promise<void> {
    const projection = await this.getProjection(workspaceId);
    if (projection.workspace.status === "deleted") {
      throw new WorkspaceExecutionStateError("workspace_deleted");
    }
    const storageBinding = await this.#resolveStorageBinding(projection, signal);
    await this.#provider.removeEnvironment(this.#environmentRemovalRequest(projection, storageBinding, signal));
  }

  async deleteWorkspace(input: WorkspaceDeletionInput): Promise<WorkspaceExecutionProjection> {
    input.signal?.throwIfAborted();
    let current = await this.#beginDeletion(input);
    while (current.workspace.status === "deleting") {
      const transactionId = current.workspace.deletionTransactionId;
      const phase = current.workspace.deletionPhase;
      if (!transactionId || !phase || phase === "deleted") {
        throw new WorkspaceExecutionStateError("workspace_deletion_state_invalid");
      }
      try {
        if (phase === "draining") {
          if (!(await this.#deletionDrain.begin(input.workspaceId, transactionId, input.signal))) {
            throw new WorkspaceExecutionStateError("workspace_deletion_drain_conflict");
          }
          current = await this.#advanceDeletion(current, "draining", "removing_environments");
          continue;
        }
        if (phase === "removing_environments") {
          const binding = await this.#resolveStorageBinding(current, input.signal);
          await this.#assertNoExternalStorageReferences(current);
          await this.#provider.removeEnvironment(this.#environmentRemovalRequest(current, binding, input.signal));
          current = await this.#advanceDeletion(current, "removing_environments", "verifying_references");
          continue;
        }
        if (phase === "verifying_references") {
          await this.#assertNoExternalStorageReferences(current);
          current = await this.#advanceDeletion(current, "verifying_references", "releasing_storage");
          continue;
        }
        if (phase === "releasing_storage") {
          const binding = await this.#resolveStorageBinding(current, input.signal);
          await this.#assertNoExternalStorageReferences(current);
          await this.#storageReleaser.releaseWorkspaceStorage({
            workspaceId: current.workspace.id,
            ownerId: current.workspace.ownerId,
            providerId: current.execution.providerId,
            storageRef: workspaceStorageRef(current.workspace, current.execution.providerId),
            binding,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          current = await this.#advanceDeletion(current, "releasing_storage", "finalizing");
          continue;
        }
        current = await this.#finalizeDeletion(current);
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason;
        await this.#recordDeletionFailure(current, error);
        throw error;
      }
    }
    const transactionId = current.workspace.deletionTransactionId;
    if (transactionId) {
      await this.#deletionDrain.clear(current.workspace.id, transactionId);
    }
    return current;
  }

  async #beginDeletion(input: WorkspaceDeletionInput): Promise<WorkspaceExecutionProjection> {
    const requestedTransactionId = executionTransactionId(
      input.workspaceId,
      input.transactionKey ?? "workspace-delete",
    );
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.getProjection(input.workspaceId);
      if (current.workspace.status === "deleted" || current.workspace.status === "deleting") return current;
      const next = structuredClone(current);
      const timestamp = this.#timestamp();
      next.workspace.status = "deleting";
      next.workspace.deletionTransactionId = requestedTransactionId;
      next.workspace.deletionPhase = "draining";
      next.workspace.deletionFailure = null;
      next.workspace.deletedAt = null;
      next.workspace.updatedAt = timestamp;
      next.execution.updatedAt = timestamp;
      const saved = await this.#store.compareAndSaveWorkspaceExecution(next, current.execution.revision);
      if (saved) return saved;
    }
    throw new WorkspaceExecutionStateError("workspace_execution_state_conflict");
  }

  async #advanceDeletion(
    current: WorkspaceExecutionProjection,
    expectedPhase: WorkspaceDeletionPhase,
    nextPhase: WorkspaceDeletionPhase,
  ): Promise<WorkspaceExecutionProjection> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const latest = await this.getProjection(current.workspace.id);
      if (latest.workspace.status === "deleted") return latest;
      if (latest.workspace.deletionTransactionId !== current.workspace.deletionTransactionId) {
        throw new WorkspaceExecutionStateError("workspace_deletion_transaction_conflict");
      }
      if (latest.workspace.deletionPhase !== expectedPhase) return latest;
      const next = structuredClone(latest);
      const timestamp = this.#timestamp();
      next.workspace.deletionPhase = nextPhase;
      next.workspace.deletionFailure = null;
      next.workspace.updatedAt = timestamp;
      next.execution.updatedAt = timestamp;
      const saved = await this.#store.compareAndSaveWorkspaceExecution(next, latest.execution.revision);
      if (saved) return saved;
    }
    throw new WorkspaceExecutionStateError("workspace_execution_state_conflict");
  }

  async #finalizeDeletion(current: WorkspaceExecutionProjection): Promise<WorkspaceExecutionProjection> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const latest = await this.getProjection(current.workspace.id);
      if (latest.workspace.status === "deleted") return latest;
      if (
        latest.workspace.deletionTransactionId !== current.workspace.deletionTransactionId
        || latest.workspace.deletionPhase !== "finalizing"
      ) {
        throw new WorkspaceExecutionStateError("workspace_deletion_transaction_conflict");
      }
      const next = structuredClone(latest);
      const timestamp = this.#timestamp();
      next.workspace.status = "deleted";
      next.workspace.activeExecutionId = null;
      next.workspace.appRevisionId = null;
      next.workspace.deletionPhase = "deleted";
      next.workspace.deletionFailure = null;
      next.workspace.deletedAt = timestamp;
      next.workspace.updatedAt = timestamp;
      next.execution.role = "retired";
      next.execution.environmentRef = null;
      next.execution.desiredState = "stopped";
      next.execution.observedState = "absent";
      next.execution.desiredAppRevisionId = null;
      next.execution.desiredLaunchArtifactId = null;
      next.execution.desiredLaunchArtifactReference = null;
      next.execution.launchArtifactId = null;
      next.execution.launchArtifactReference = null;
      next.execution.transactionStatus = "applied";
      next.execution.legacyEndpoint = null;
      next.execution.stopReason = null;
      next.execution.retiredAt = timestamp;
      next.execution.updatedAt = timestamp;
      next.compatibility.runtimeId = "deleted";
      next.compatibility.status = "stopped";
      const saved = await this.#store.compareAndSaveWorkspaceExecution(next, latest.execution.revision);
      if (saved) return saved;
    }
    throw new WorkspaceExecutionStateError("workspace_execution_state_conflict");
  }

  async #recordDeletionFailure(current: WorkspaceExecutionProjection, error: unknown): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const latest = await this.#store.getWorkspaceExecutionProjection(current.workspace.id);
      if (
        !latest
        || latest.workspace.status !== "deleting"
        || latest.workspace.deletionTransactionId !== current.workspace.deletionTransactionId
      ) return;
      const next = structuredClone(latest);
      const timestamp = this.#timestamp();
      next.workspace.deletionFailure = deletionFailureCode(error);
      next.workspace.updatedAt = timestamp;
      next.execution.updatedAt = timestamp;
      if (await this.#store.compareAndSaveWorkspaceExecution(next, latest.execution.revision)) return;
    }
  }

  async #assertNoExternalStorageReferences(projection: WorkspaceExecutionProjection): Promise<void> {
    const references = await this.#store.countLiveWorkspaceStorageReferences(
      projection.workspace.storageRefId,
      projection.workspace.id,
    );
    if (references !== 0) {
      throw new WorkspaceExecutionStateError("workspace_storage_still_referenced");
    }
  }

  #environmentRemovalRequest(
    projection: WorkspaceExecutionProjection,
    storageBinding: StorageBinding,
    signal?: AbortSignal,
  ): ExecutionEnvironmentRemovalRequest {
    return {
      workspaceId: projection.workspace.id,
      ownerId: projection.workspace.ownerId,
      ...providerRouteFields(this.#provider, projection.execution.providerId),
      storageBindings: [structuredClone(storageBinding)],
      ...(signal ? { signal } : {}),
    };
  }

  #assertActive(projection: WorkspaceExecutionProjection): void {
    if (projection.workspace.status !== "active") {
      throw new WorkspaceExecutionStateError(
        projection.workspace.status === "deleted" ? "workspace_deleted" : "workspace_deleting",
      );
    }
  }

  async #persistIntent(
    input: WorkspaceExecutionReconcileInput,
    transactionId: string,
  ): Promise<WorkspaceExecutionProjection> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.getProjection(input.workspaceId);
      this.#assertActive(current);
      const providerId = input.providerId ?? current.execution.providerId;
      assertReconcileIdentity(current, input, providerId);
      if (completedTransaction(current, input, transactionId)) return current;
      const sameTransaction = current.execution.transactionId === transactionId;
      const desiredGeneration = sameTransaction
        ? current.execution.desiredGeneration
        : input.replace
          ? current.execution.desiredGeneration + 1
          : current.execution.desiredGeneration;
      const next = structuredClone(current);
      next.workspace.updatedAt = this.#timestamp();
      next.execution.desiredGeneration = desiredGeneration;
      next.execution.desiredState = input.desiredState;
      next.execution.desiredAppRevisionId = input.appRevisionId;
      next.execution.desiredLaunchArtifactId = input.launchArtifactId;
      next.execution.desiredLaunchArtifactReference = input.launchArtifactReference;
      next.execution.transactionId = transactionId;
      next.execution.transactionStatus = "progressing";
      next.execution.updatedAt = next.workspace.updatedAt;
      const saved = await this.#store.compareAndSaveWorkspaceExecution(next, current.execution.revision);
      if (saved) return saved;
    }
    throw new WorkspaceExecutionStateError("workspace_execution_state_conflict");
  }

  async #resolveStorageBinding(projection: WorkspaceExecutionProjection, signal?: AbortSignal) {
    const storageBinding = await this.#storageBindingResolver.resolveStorageBinding({
      workspaceId: projection.workspace.id,
      ownerId: projection.workspace.ownerId,
      providerId: projection.execution.providerId,
      storageRef: workspaceStorageRef(projection.workspace, projection.execution.providerId),
      ...(signal ? { signal } : {}),
    });
    if (storageBinding.storageId !== projection.workspace.storageRefId) {
      throw new WorkspaceExecutionStateError("workspace_storage_binding_identity_mismatch");
    }
    return structuredClone(storageBinding);
  }

  async #commitResult(
    input: WorkspaceExecutionReconcileInput,
    result: ExecutionReconcileResult,
  ): Promise<WorkspaceExecutionProjection> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.getProjection(input.workspaceId);
      this.#assertActive(current);
      if (
        current.execution.transactionId !== result.transactionId
        || current.execution.desiredGeneration !== result.generation
      ) {
        if (completedTransaction(current, input, result.transactionId)) return current;
        throw new WorkspaceExecutionStateError("workspace_execution_transaction_superseded");
      }
      assertProviderExecution(current, result.execution);
      const next = structuredClone(current);
      const updatedAt = this.#timestamp();
      next.workspace.updatedAt = updatedAt;
      next.execution.environmentRef = result.execution.environmentRef;
      next.execution.observedState = result.execution.observedState;
      next.execution.updatedAt = updatedAt;
      next.execution.legacyEndpoint = result.execution.observedState === "running"
        ? current.execution.legacyEndpoint
        : null;
      next.compatibility.runtimeId = result.execution.environmentRef;
      next.compatibility.status = compatibleObservedState(result.execution.observedState);
      if (result.status === "rolled_back") {
        next.execution.transactionStatus = "rolled_back";
      } else {
        assertCatalogResult(input, result.execution);
        next.workspace.appRevisionId = input.appRevisionId;
        next.execution.deployedGeneration = result.generation;
        next.execution.launchArtifactId = input.launchArtifactId;
        next.execution.launchArtifactReference = input.launchArtifactReference;
        next.execution.transactionStatus = result.status === "awaiting_first_start"
          ? "awaiting_first_start"
          : "applied";
        if (result.execution.observedState === "running") {
          next.execution.healthyGeneration = result.generation;
          next.execution.stopReason = null;
        }
      }
      const saved = await this.#store.compareAndSaveWorkspaceExecution(next, current.execution.revision);
      if (saved) return saved;
    }
    throw new WorkspaceExecutionStateError("workspace_execution_state_conflict");
  }

  async #recordProviderFailure(workspaceId: string, transactionId: string, error: unknown): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.getProjection(workspaceId);
      if (current.workspace.status !== "active") return;
      if (current.execution.transactionId !== transactionId) return;
      const next = structuredClone(current);
      next.execution.transactionStatus = error instanceof ProviderOperationError && error.failureClass === "inconsistent"
        ? "inconsistent"
        : "failed";
      next.execution.updatedAt = this.#timestamp();
      next.workspace.updatedAt = next.execution.updatedAt;
      if (await this.#store.compareAndSaveWorkspaceExecution(next, current.execution.revision)) return;
    }
    throw new WorkspaceExecutionStateError("workspace_execution_state_conflict");
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

export function executionTransactionId(workspaceId: string, transactionKey: string): string {
  const normalized = transactionKey.trim();
  if (!normalized) throw new WorkspaceExecutionStateError("workspace_execution_transaction_key_required");
  const digest = createHash("sha256").update(workspaceId).update("\0").update(normalized).digest("hex").slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}

function completedTransaction(
  projection: WorkspaceExecutionProjection,
  input: WorkspaceExecutionReconcileInput,
  transactionId: string,
): boolean {
  return projection.execution.transactionId === transactionId
    && (projection.execution.transactionStatus === "applied"
      || projection.execution.transactionStatus === "awaiting_first_start")
    && projection.execution.deployedGeneration === projection.execution.desiredGeneration
    && projection.execution.desiredState === input.desiredState
    && projection.execution.desiredAppRevisionId === input.appRevisionId
    && projection.execution.desiredLaunchArtifactId === input.launchArtifactId
    && projection.execution.desiredLaunchArtifactReference === input.launchArtifactReference;
}

function deletionFailureCode(error: unknown): string {
  if (error instanceof ProviderOperationError || error instanceof WorkspaceExecutionStateError) {
    return error.code;
  }
  return "workspace_deletion_failed";
}

function assertReconcileIdentity(
  projection: WorkspaceExecutionProjection,
  input: WorkspaceExecutionReconcileInput,
  providerId: string,
): void {
  if (projection.workspace.status !== "active") {
    throw new WorkspaceExecutionStateError("workspace_not_active");
  }
  if (
    projection.workspace.ownerId !== input.ownerId
    || projection.workspace.appId !== input.appId
    || projection.execution.providerId !== providerId
  ) {
    throw new WorkspaceExecutionStateError("workspace_execution_identity_mismatch");
  }
}

function assertProviderExecution(
  projection: WorkspaceExecutionProjection,
  execution: ProviderExecution,
): void {
  if (
    execution.workspaceId !== projection.workspace.id
    || execution.ownerId !== projection.workspace.ownerId
    || (execution.providerId !== undefined && execution.providerId !== projection.execution.providerId)
    || !execution.environmentRef
  ) {
    throw new WorkspaceExecutionStateError("provider_execution_identity_mismatch");
  }
}

function assertCatalogResult(input: WorkspaceExecutionReconcileInput, execution: ProviderExecution): void {
  const snapshot = execution.catalogSnapshot;
  if (!snapshot) return;
  if (
    snapshot.appId !== input.appId
    || snapshot.appVersionId !== input.appRevisionId
    || snapshot.imageArtifactId !== input.launchArtifactId
    || snapshot.imageReference !== input.launchArtifactReference
  ) {
    throw new WorkspaceExecutionStateError("provider_execution_catalog_mismatch");
  }
}

function compatibleObservedState(state: ProviderExecution["observedState"]): Container["status"] {
  if (state === "creating" || state === "running" || state === "stopped" || state === "failed") return state;
  throw new WorkspaceExecutionStateError("provider_execution_state_unavailable");
}

function assertLegacyIdentity(current: Container, next: Container): void {
  if (
    current.id !== next.id
    || current.userId !== next.userId
    || current.appId !== next.appId
    || current.createdAt !== next.createdAt
  ) {
    throw new WorkspaceExecutionStateError("workspace_execution_identity_mismatch");
  }
}

function sameLegacyContainer(left: Container, right: Container): boolean {
  return left.id === right.id
    && left.userId === right.userId
    && left.appId === right.appId
    && left.runtimeId === right.runtimeId
    && left.status === right.status
    && left.endpoint === right.endpoint
    && left.stopReason === right.stopReason
    && left.createdAt === right.createdAt
    && left.updatedAt === right.updatedAt
    && left.lastActivityAt === right.lastActivityAt
    && (left.appVersionId ?? null) === (right.appVersionId ?? null)
    && (left.imageArtifactId ?? null) === (right.imageArtifactId ?? null)
    && (left.imageReference ?? null) === (right.imageReference ?? null);
}

function latestTimestamp(left: string, right: string): string {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime)) return right;
  if (!Number.isFinite(rightTime)) return left;
  return rightTime > leftTime ? right : left;
}

/**
 * Provider 路由引入前只有 Docker 合同。直接使用旧 Docker 传输时省略可选字段，
 * 保持旧调用方的精确请求形状；路由门面默认 Provider 不是 Docker 时仍显式传入 pin，
 * 防止工作区意外回落到默认 Provider。
 */
function providerRouteFields(
  transport: object,
  providerId: string,
): { providerId?: string } {
  return providerRouteArgument(transport, providerId) === undefined ? {} : { providerId };
}

function legacyProviderArgument(
  transport: object,
  providerId: string,
): string | undefined {
  return providerRouteArgument(transport, providerId);
}

function providerRouteArgument(
  transport: object,
  providerId: string,
): string | undefined {
  const transportProviderId = "providerId" in transport
    && typeof transport.providerId === "string"
    ? transport.providerId
    : "docker";
  if (providerId === "docker" && transportProviderId === "docker") return undefined;
  return providerId;
}
