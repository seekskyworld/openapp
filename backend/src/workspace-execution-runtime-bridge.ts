import type { ProviderExecution, ProviderMetricsPort } from "./execution-provider.js";
import type {
  ContainerActivityMetrics,
  ContainerCatalogSnapshot,
  ContainerInstance,
  ContainerLaunchProfile,
  ContainerRuntime,
  DeferredCandidateAcceptance,
} from "./runtime.js";
import type { WorkspaceExecutionProjection } from "./workspace-execution.js";
import {
  WorkspaceExecutionManager,
  type WorkspaceExecutionReconcileInput,
} from "./workspace-execution-manager.js";
import { requireProviderMetrics } from "./provider-observability.js";

/**
 * 旧 Lifecycle 暂时保留 ContainerRuntime 形状。该桥只负责兼容调用签名；所有执行副作用和
 * 状态提交已经进入 WorkspaceExecutionManager，步骤 7 后访问目标也会从本桥移除。
 */
export class WorkspaceExecutionRuntimeBridge implements ContainerRuntime {
  readonly #manager: WorkspaceExecutionManager;
  readonly #metrics: ProviderMetricsPort;
  readonly #launchProfileFor: (imageReference: string) => Promise<ContainerLaunchProfile>;
  readonly #defaultAppId?: string | (() => Promise<string>);

  constructor(options: {
    manager: WorkspaceExecutionManager;
    metrics: ProviderMetricsPort;
    launchProfileFor: (imageReference: string) => Promise<ContainerLaunchProfile>;
    /** Used only by legacy provision callers that omit the App id. */
    defaultAppId?: string | (() => Promise<string>);
  }) {
    this.#manager = options.manager;
    this.#metrics = options.metrics;
    this.#launchProfileFor = options.launchProfileFor;
    this.#defaultAppId = options.defaultAppId;
  }

  async provision(request: Parameters<ContainerRuntime["provision"]>[0]): Promise<ContainerInstance> {
    if (!request.launchProfile || !request.imageReference) {
      throw new Error("workspace_execution_launch_profile_required");
    }
    const projection = await this.#manager.reconcile({
      workspaceId: request.instanceId,
      ownerId: request.ownerId,
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.executionContract === undefined ? {} : { executionContract: request.executionContract }),
      appId: request.appId ?? await this.#resolveDefaultAppId(),
      appRevisionId: request.appVersionId ?? null,
      launchArtifactId: request.imageArtifactId ?? null,
      launchArtifactReference: request.imageReference,
      launchProfile: request.launchProfile,
      desiredState: request.start === false ? "stopped" : "running",
      replace: false,
      transactionKey: `provision:${request.instanceId}`,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return this.#projectionInstance(projection);
  }

  async #resolveDefaultAppId(): Promise<string> {
    const appId = typeof this.#defaultAppId === "function" ? await this.#defaultAppId() : this.#defaultAppId;
    if (!appId?.trim()) throw new Error("workspace_execution_app_id_required");
    return appId.trim().toLowerCase();
  }

  async get(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance | null> {
    const execution = await this.#manager.observe(instanceId, signal);
    return execution ? this.#providerInstance(execution) : null;
  }

  async observe(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance | null> {
    const execution = await this.#manager.inspect(instanceId, signal);
    return execution ? this.#providerInstance(execution) : null;
  }

  async start(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance> {
    return this.#reconcileCurrent(instanceId, "running", signal);
  }

  async stop(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance> {
    return this.#reconcileCurrent(instanceId, "stopped", signal);
  }

  async rebuild(request: Parameters<NonNullable<ContainerRuntime["rebuild"]>>[0]): Promise<ContainerInstance> {
    if (!request.launchProfile || !request.imageReference) {
      throw new Error("workspace_execution_launch_profile_required");
    }
    const current = await this.#manager.getProjection(request.instanceId);
    const input: WorkspaceExecutionReconcileInput = {
      workspaceId: request.instanceId,
      ownerId: request.ownerId,
      ...(request.providerId ? { providerId: request.providerId } : {}),
      ...(request.executionContract === undefined ? {} : { executionContract: request.executionContract }),
      appId: request.appId ?? current.workspace.appId,
      appRevisionId: request.appVersionId ?? null,
      launchArtifactId: request.imageArtifactId ?? null,
      launchArtifactReference: request.imageReference,
      ...(request.sourceCatalogSnapshot ? { sourceCatalogSnapshot: request.sourceCatalogSnapshot } : {}),
      launchProfile: request.launchProfile,
      desiredState: request.start === false ? "stopped" : "running",
      replace: true,
      ...(request.rebuildTransactionId ? { transactionKey: request.rebuildTransactionId } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    };
    return this.#projectionInstance(await this.#manager.reconcile(input));
  }

  async acceptDeferredCandidate(
    instanceId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<DeferredCandidateAcceptance> {
    return this.#manager.acceptDeferredExecution(instanceId, ownerId, signal);
  }

  async inspectRebuildTransaction(
    instanceId: string,
    transactionId: string,
    signal?: AbortSignal,
  ) {
    const inspection = await this.#manager.inspectTransaction(instanceId, transactionId, signal);
    return inspection ? {
      status: inspection.status,
      instance: inspection.execution ? this.#providerInstance(inspection.execution) : null,
    } : { status: "not_found" as const, instance: null };
  }

  sampleActivity(instanceId: string, signal?: AbortSignal): Promise<ContainerActivityMetrics> {
    return requireProviderMetrics(this.#metrics, instanceId, signal);
  }

  async remove(instanceId: string, _ownerId: string, signal?: AbortSignal): Promise<void> {
    await this.#manager.deleteWorkspace({
      workspaceId: instanceId,
      ...(signal ? { signal } : {}),
    });
  }

  async #reconcileCurrent(
    workspaceId: string,
    desiredState: "running" | "stopped",
    signal?: AbortSignal,
  ): Promise<ContainerInstance> {
    const current = await this.#manager.getProjection(workspaceId);
    const imageReference = current.execution.launchArtifactReference;
    if (!imageReference) throw new Error("workspace_execution_launch_artifact_missing");
    const projection = await this.#manager.reconcile({
      workspaceId,
      ownerId: current.workspace.ownerId,
      appId: current.workspace.appId,
      appRevisionId: current.workspace.appRevisionId,
      launchArtifactId: current.execution.launchArtifactId,
      launchArtifactReference: imageReference,
      sourceCatalogSnapshot: catalogSnapshot(current),
      launchProfile: await this.#launchProfileFor(imageReference),
      desiredState,
      replace: false,
      ...(signal ? { signal } : {}),
    });
    return this.#projectionInstance(projection);
  }

  #projectionInstance(projection: WorkspaceExecutionProjection): ContainerInstance {
    const environmentRef = projection.execution.environmentRef;
    if (!environmentRef) throw new Error("workspace_execution_environment_missing");
    return this.#providerInstance({
      workspaceId: projection.workspace.id,
      ownerId: projection.workspace.ownerId,
      environmentRef,
      ...(projection.execution.providerId === "docker" ? {} : { providerId: projection.execution.providerId }),
      observedState: projection.execution.observedState,
      createdAt: projection.workspace.createdAt,
      ...(catalogSnapshot(projection) ? { catalogSnapshot: catalogSnapshot(projection) } : {}),
      ...(projection.execution.transactionStatus === "rolled_back" ? { transactionRecovered: true } : {}),
    });
  }

  #providerInstance(execution: ProviderExecution): ContainerInstance {
    const state = compatibleState(execution.observedState);
    return {
      instanceId: execution.workspaceId,
      ownerId: execution.ownerId,
      runtimeId: execution.environmentRef,
      ...(execution.providerId ? { providerId: execution.providerId } : {}),
      state,
      endpoint: null,
      createdAt: execution.createdAt,
      ...(execution.catalogSnapshot ? { catalogSnapshot: structuredClone(execution.catalogSnapshot) } : {}),
      ...(execution.transactionRecovered ? { rebuildRecovered: true } : {}),
    };
  }
}

function catalogSnapshot(projection: WorkspaceExecutionProjection): ContainerCatalogSnapshot | undefined {
  const imageReference = projection.execution.launchArtifactReference;
  if (!imageReference) return undefined;
  return {
    appId: projection.workspace.appId,
    appVersionId: projection.workspace.appRevisionId,
    imageArtifactId: projection.execution.launchArtifactId,
    imageReference,
  };
}

function compatibleState(state: ProviderExecution["observedState"]): ContainerInstance["state"] {
  if (state === "creating" || state === "running" || state === "stopped" || state === "failed") return state;
  throw new Error("workspace_execution_observation_unavailable");
}
