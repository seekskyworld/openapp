import type {
  AccessTarget,
  AccessTargetRequest,
  AccessTargetResolver,
  ExecutionControlPort,
  ExecutionEnvironmentRemovalRequest,
  ExecutionObservationRequest,
  ExecutionReconcileRequest,
  ExecutionReconcileResult,
  ExecutionTransactionPort,
  ProviderCapabilityResult,
  ProviderDiagnosticsPort,
  ProviderExecution,
  ProviderHealthPort,
  ProviderMetricsPort,
  ProviderOperationPhase,
  StorageBindingResolutionRequest,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort,
  WorkspaceStorageReleaseRequest,
} from "./execution-provider.js";
import { ProviderOperationError } from "./execution-provider.js";
import type {
  ContainerActivityMetrics,
  ContainerFailureDiagnostics,
  ContainerInstance,
  ContainerRuntime,
} from "./runtime.js";
import { ContainerRebuildRollbackError, ManagedResourceResolutionError } from "./runtime.js";
import { GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT } from "./runtime-contracts.js";
import type { ProviderDescriptor } from "./execution-provider-registry.js";
import {
  assertProviderRequestSupported,
  assertProviderStorageSupported,
  providerRequestFromReconcile,
  providerNotFound,
} from "./provider-adapter-contract.js";

export interface DockerProviderOptions {
  metrics?: boolean;
  /** Provider 实际允许的工作负载合同；显式传入时不再使用产品默认值。 */
  supportedExecutionContracts?: readonly string[];
  /** 直接构造的旧调用方可省略；通用组合根应显式传 false。 */
  compatibilityMode?: boolean;
}

/**
 * 该适配器只翻译 Provider 合同，重建 rename、回滚和锁恢复仍由经过故障矩阵验证的
 * DockerCliRuntime 拥有，避免在抽象迁移时复制第二套事务实现。
 */
export class DockerProviderAdapter implements
  ExecutionControlPort,
  ExecutionTransactionPort,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort,
  AccessTargetResolver,
  ProviderMetricsPort,
  ProviderDiagnosticsPort,
  ProviderHealthPort {
  readonly providerId = "docker";
  readonly descriptor: ProviderDescriptor;
  readonly #runtime: ContainerRuntime;
  readonly #capabilities: DockerProviderOptions;

  constructor(runtime: ContainerRuntime, capabilities: DockerProviderOptions = {}) {
    this.#runtime = runtime;
    this.#capabilities = capabilities;
    const supportedExecutionContracts = capabilities.supportedExecutionContracts
      ? normalizeExecutionContracts(capabilities.supportedExecutionContracts)
      : capabilities.compatibilityMode === false
        ? [GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT]
        : [GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT];
    this.descriptor = {
      descriptorVersion: 1,
      id: "docker",
      environmentKind: "container",
      workloadClass: "dedicated",
      accessMode: "direct_http",
      supportedArtifactKinds: ["oci-image"],
      supportedExecutionContracts,
      supportedStorageClasses: ["workspace-data"],
      resourceLimits: {
        minMemoryBytes: 1,
        maxMemoryBytes: 1024 ** 5,
        minCpuMillis: 1,
        maxCpuMillis: 256_000,
        minPidsLimit: 1,
        maxPidsLimit: 1_048_576,
      },
      capabilities: {
        rollback: "transactional",
        workloadHealth: "probe",
        metrics: true,
        diagnostics: true,
      },
    };
  }

  async resolveStorageBinding(request: StorageBindingResolutionRequest) {
    request.signal?.throwIfAborted();
    assertProviderStorageSupported(this.descriptor, request.storageRef.storageClass, "resolve_storage");
    if (!this.#runtime.resolveStorageBinding) {
      throw new ProviderOperationError(
        "provider_storage_binding_unsupported",
        "permanent",
        "resolve_storage",
      );
    }
    if (
      request.providerId !== this.providerId
      || (request.storageRef.affinity && request.storageRef.affinity.providerId !== this.providerId)
    ) {
      throw new ProviderOperationError(
        "provider_storage_affinity_mismatch",
        "inconsistent",
        "resolve_storage",
      );
    }
    try {
      return await this.#runtime.resolveStorageBinding({
        workspaceId: request.workspaceId,
        ownerId: request.ownerId,
        storageId: request.storageRef.id,
        storageClass: request.storageRef.storageClass,
        affinityProviderId: request.storageRef.affinity?.providerId,
        affinityRegion: request.storageRef.affinity?.region,
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (error) {
      throw normalizeProviderError(error, "resolve_storage", request.signal);
    }
  }

  async observe(request: ExecutionObservationRequest): Promise<ProviderExecution | null> {
    request.signal?.throwIfAborted();
    try {
      const instance = await this.#runtime.get(
        request.workspaceId,
        request.signal,
        request.storageBindings,
      );
      request.signal?.throwIfAborted();
      verifyOwner(instance, request.expectedOwnerId);
      return instance ? providerExecution(instance) : null;
    } catch (error) {
      throw normalizeProviderError(error, "observe", request.signal);
    }
  }

  async inspect(workspaceId: string, signal?: AbortSignal): Promise<ProviderExecution | null> {
    signal?.throwIfAborted();
    try {
      const instance = this.#runtime.observe
        ? await this.#runtime.observe(workspaceId, signal)
        : await this.#runtime.get(workspaceId, signal);
      signal?.throwIfAborted();
      return instance ? providerExecution(instance) : null;
    } catch (error) {
      throw normalizeProviderError(error, "observe", signal);
    }
  }

  async reconcile(request: ExecutionReconcileRequest): Promise<ExecutionReconcileResult> {
    request.signal?.throwIfAborted();
    assertProviderRequestSupported(this.descriptor, providerRequestFromReconcile(request), "reconcile");
    try {
      const current = await this.#runtime.get(
        request.workspaceId,
        request.signal,
        request.storageBindings,
      );
      verifyOwner(current, request.ownerId);
      let instance: ContainerInstance;
      if (request.replace) {
        if (!this.#runtime.rebuild) {
          throw new ProviderOperationError(
            "provider_rebuild_unsupported",
            "permanent",
            "reconcile",
          );
        }
        instance = await this.#runtime.rebuild(runtimeRequest(request));
      } else if (!current) {
        instance = await this.#runtime.provision(runtimeRequest(request));
      } else if (request.desiredState === "running" && current.state !== "running") {
        instance = await this.#runtime.start(request.workspaceId, request.signal, request.storageBindings);
      } else if (request.desiredState === "stopped" && current.state === "running") {
        instance = await this.#runtime.stop(request.workspaceId, request.signal);
      } else {
        instance = current;
      }
      verifyOwner(instance, request.ownerId);
      if (request.desiredState === "stopped" && instance.state === "running") {
        instance = await this.#runtime.stop(request.workspaceId, request.signal);
        verifyOwner(instance, request.ownerId);
      }
      request.signal?.throwIfAborted();
      return {
        status: request.replace && request.desiredState === "stopped" ? "awaiting_first_start" : "applied",
        generation: request.desiredGeneration,
        transactionId: request.transactionId,
        execution: providerExecution(instance),
      };
    } catch (error) {
      if (error instanceof ContainerRebuildRollbackError) {
        verifyOwner(error.recoveredInstance, request.ownerId);
        return {
          status: "rolled_back",
          generation: request.desiredGeneration,
          transactionId: request.transactionId,
          execution: providerExecution(error.recoveredInstance),
        };
      }
      throw normalizeProviderError(error, "reconcile", request.signal);
    }
  }

  async removeEnvironment(request: ExecutionEnvironmentRemovalRequest): Promise<void> {
    request.signal?.throwIfAborted();
    if (!this.#runtime.removeEnvironment) {
      throw new ProviderOperationError("provider_environment_removal_unsupported", "permanent", "remove");
    }
    try {
      await this.#runtime.removeEnvironment({
        instanceId: request.workspaceId,
        ownerId: request.ownerId,
        storageBindings: request.storageBindings,
        ...(request.signal ? { signal: request.signal } : {}),
      });
      request.signal?.throwIfAborted();
    } catch (error) {
      throw normalizeProviderError(error, "remove", request.signal);
    }
  }

  async releaseWorkspaceStorage(request: WorkspaceStorageReleaseRequest): Promise<void> {
    request.signal?.throwIfAborted();
    assertProviderStorageSupported(this.descriptor, request.storageRef.storageClass, "release_storage");
    if (!this.#runtime.releaseWorkspaceStorage) {
      throw new ProviderOperationError("provider_storage_release_unsupported", "permanent", "release_storage");
    }
    if (
      request.providerId !== this.providerId
      || request.storageRef.affinity?.providerId !== this.providerId
      || request.binding.storageId !== request.storageRef.id
    ) {
      throw new ProviderOperationError("provider_storage_release_identity_mismatch", "inconsistent", "release_storage");
    }
    try {
      await this.#runtime.releaseWorkspaceStorage({
        instanceId: request.workspaceId,
        ownerId: request.ownerId,
        storageBindings: [request.binding],
        ...(request.signal ? { signal: request.signal } : {}),
      });
      request.signal?.throwIfAborted();
    } catch (error) {
      throw normalizeProviderError(error, "release_storage", request.signal);
    }
  }

  async acceptDeferredExecution(
    workspaceId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<"accepted" | "already_baseline" | "not_found"> {
    if (!this.#runtime.acceptDeferredCandidate) return "not_found";
    try {
      return await this.#runtime.acceptDeferredCandidate(workspaceId, ownerId, signal);
    } catch (error) {
      throw normalizeProviderError(error, "reconcile", signal);
    }
  }

  async inspectTransaction(
    workspaceId: string,
    transactionId: string,
    signal?: AbortSignal,
  ) {
    if (!this.#runtime.inspectRebuildTransaction) return null;
    try {
      const inspection = await this.#runtime.inspectRebuildTransaction(workspaceId, transactionId, signal);
      return {
        status: inspection.status,
        execution: inspection.instance ? providerExecution(inspection.instance) : null,
      };
    } catch (error) {
      throw normalizeProviderError(error, "observe", signal);
    }
  }

  async resolveAccessTarget(request: AccessTargetRequest): Promise<AccessTarget> {
    request.signal?.throwIfAborted();
    try {
      const instance = this.#runtime.observe
        ? await this.#runtime.observe(request.workspaceId, request.signal)
        : await this.#runtime.get(request.workspaceId, request.signal);
      if (!instance || instance.state !== "running" || !instance.endpoint) {
        if (!instance) throw providerNotFound("provider_environment_not_found", "resolve_target");
        throw new ProviderOperationError(
          "provider_access_target_unavailable",
          "transient",
          "resolve_target",
          1_000,
        );
      }
      verifyOwner(instance, request.expectedOwnerId);
      const url = trustedHttpTarget(instance.endpoint);
      return {
        providerId: this.providerId,
        environmentRef: instance.runtimeId,
        logicalService: request.logicalService,
        url,
        expiresAt: null,
      };
    } catch (error) {
      throw normalizeProviderError(error, "resolve_target", request.signal);
    }
  }

  async readMetrics(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<ProviderCapabilityResult<ContainerActivityMetrics>> {
    if (!this.#capabilities.metrics) return { status: "unsupported" };
    try {
      return { status: "supported", value: await this.#runtime.sampleActivity(workspaceId, signal) };
    } catch (error) {
      return { status: "unavailable", error: normalizeProviderError(error, "diagnose", signal) };
    }
  }

  async readDiagnostics(
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<ProviderCapabilityResult<ContainerFailureDiagnostics>> {
    if (!this.#runtime.diagnose) return { status: "unsupported" };
    try {
      return { status: "supported", value: await this.#runtime.diagnose(workspaceId, signal) };
    } catch (error) {
      return { status: "unavailable", error: normalizeProviderError(error, "diagnose", signal) };
    }
  }

  async readProviderHealth(): Promise<ProviderCapabilityResult<{
    providerId: string;
    available: boolean;
    version?: string;
    host?: string;
    platform?: string;
    architecture?: string;
  }>> {
    if (!this.#runtime.status) return { status: "unsupported" };
    try {
      const status = await this.#runtime.status();
      if (!status.available) {
        return {
          status: "unavailable",
          error: new ProviderOperationError("provider_unavailable", "transient", "diagnose", 5_000),
        };
      }
      const { error: _error, runtime: _runtime, ...details } = status;
      return { status: "supported", value: { providerId: this.providerId, ...details } };
    } catch (error) {
      return { status: "unavailable", error: normalizeProviderError(error, "diagnose") };
    }
  }
}

function runtimeRequest(request: ExecutionReconcileRequest) {
  return {
    instanceId: request.workspaceId,
    ownerId: request.ownerId,
    appId: request.appId,
    appVersionId: request.appRevisionId,
    imageArtifactId: request.launchArtifactId,
    imageReference: request.launchArtifactReference,
    ...(request.executionContract === undefined ? {} : { executionContract: request.executionContract }),
    ...(request.sourceCatalogSnapshot ? { sourceCatalogSnapshot: request.sourceCatalogSnapshot } : {}),
    launchProfile: request.launchProfile,
    storageBindings: request.storageBindings,
    start: request.desiredState === "running",
    rebuildTransactionId: request.transactionId,
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

function normalizeExecutionContracts(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error("provider_execution_contracts_invalid");
  const normalized = values.map((value) => {
    const contract = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(contract)) {
      throw new Error("provider_execution_contracts_invalid");
    }
    return contract;
  });
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
    throw new Error("provider_execution_contracts_invalid");
  }
  return normalized;
}

function providerExecution(instance: ContainerInstance): ProviderExecution {
  return {
    workspaceId: instance.instanceId,
    ownerId: instance.ownerId,
    environmentRef: instance.runtimeId,
    observedState: instance.state,
    createdAt: instance.createdAt,
    ...(instance.catalogSnapshot ? { catalogSnapshot: structuredClone(instance.catalogSnapshot) } : {}),
    ...(instance.rebuildRecovered ? { transactionRecovered: true } : {}),
  };
}

function verifyOwner(instance: ContainerInstance | null, expectedOwnerId: string): void {
  if (instance && instance.ownerId !== expectedOwnerId) {
    throw new ProviderOperationError(
      "provider_environment_owner_mismatch",
      "inconsistent",
      "reconcile",
    );
  }
}

function trustedHttpTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderOperationError("provider_access_target_invalid", "inconsistent", "resolve_target");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ProviderOperationError("provider_access_target_invalid", "inconsistent", "resolve_target");
  }
  return url;
}

function normalizeProviderError(
  error: unknown,
  phase: ProviderOperationPhase,
  signal?: AbortSignal,
): ProviderOperationError {
  if (error instanceof ProviderOperationError) return error;
  if (error instanceof ManagedResourceResolutionError) {
    return new ProviderOperationError(
      error.code,
      "permanent",
      phase,
      undefined,
      { cause: error },
    );
  }
  if (signal?.aborted || isAbortError(error)) {
    return new ProviderOperationError("provider_operation_cancelled", "cancelled", phase, undefined, { cause: error });
  }
  return new ProviderOperationError("provider_operation_failed", "transient", phase, 1_000, { cause: error });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
