import type {
  AccessTarget,
  AccessTargetRequest,
  ExecutionControlPort,
  ExecutionEnvironmentRemovalRequest,
  ExecutionObservationRequest,
  ExecutionReconcileRequest,
  ExecutionReconcileResult,
  ExecutionTransactionInspection,
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
import type { ContainerActivityMetrics, ContainerFailureDiagnostics, StorageBinding } from "./runtime.js";
import type { ExecutionProviderAdapter, ProviderDescriptor } from "./execution-provider-registry.js";
import {
  assertProviderRequestSupported,
  assertProviderStorageSupported,
  providerNotFound,
  providerRequestFromReconcile,
} from "./provider-adapter-contract.js";
import { GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT } from "./runtime-contracts.js";

export interface ContractProviderOptions {
  providerId?: string;
  endpointBaseUrl?: string;
  metrics?: "supported" | "unsupported" | "unavailable";
  diagnostics?: "supported" | "unsupported" | "unavailable";
  health?: "available" | "unavailable" | "unsupported";
  /** 显式声明该测试/合同 Provider 接受的工作负载合同。 */
  supportedExecutionContracts?: readonly string[];
  /** 省略合同列表时，false 表示只启用平台中性合同。 */
  compatibilityMode?: boolean;
}

interface ContractEnvironment {
  ownerId: string;
  environmentRef: string;
  state: "creating" | "running" | "stopped" | "failed";
  endpoint: string;
  createdAt: string;
  catalogSnapshot?: ProviderExecution["catalogSnapshot"];
}

/**
 * A deterministic, network-free Provider used for M7 contract and fault
 * injection tests. It models a provider-proxy environment without pretending
 * to be a production Daytona/Kubernetes client.
 */
export class ContractProviderAdapter implements
  ExecutionProviderAdapter,
  ExecutionTransactionPort,
  ProviderMetricsPort,
  ProviderDiagnosticsPort,
  ProviderHealthPort {
  readonly providerId: string;
  readonly descriptor: ProviderDescriptor;
  readonly #endpointBaseUrl: URL;
  readonly #metricsMode: NonNullable<ContractProviderOptions["metrics"]>;
  readonly #diagnosticsMode: NonNullable<ContractProviderOptions["diagnostics"]>;
  readonly #healthMode: NonNullable<ContractProviderOptions["health"]>;
  readonly #environments = new Map<string, ContractEnvironment>();
  readonly #storage = new Map<string, StorageBinding>();
  readonly #transactions = new Map<string, ProviderExecution>();

  constructor(options: ContractProviderOptions = {}) {
    this.providerId = normalizeProviderId(options.providerId ?? "contract");
    this.#endpointBaseUrl = trustedBaseUrl(options.endpointBaseUrl ?? "http://contract-provider.invalid/");
    this.#metricsMode = options.metrics ?? "supported";
    this.#diagnosticsMode = options.diagnostics ?? "supported";
    this.#healthMode = options.health ?? "available";
    const supportedExecutionContracts = options.supportedExecutionContracts
      ? normalizeExecutionContracts(options.supportedExecutionContracts)
      : options.compatibilityMode === false
        ? [GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT]
        : [GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT];
    this.descriptor = {
      descriptorVersion: 1,
      id: this.providerId,
      environmentKind: "opaque",
      workloadClass: "dedicated",
      accessMode: "provider_proxy",
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
        metrics: this.#metricsMode === "supported",
        diagnostics: this.#diagnosticsMode === "supported",
      },
    };
  }

  async resolveStorageBinding(request: StorageBindingResolutionRequest): Promise<StorageBinding> {
    request.signal?.throwIfAborted();
    assertProviderStorageSupported(this.descriptor, request.storageRef.storageClass, "resolve_storage");
    this.assertProvider(request.providerId, "resolve_storage");
    if (request.storageRef.affinity?.providerId !== this.providerId) {
      throw providerError("provider_storage_affinity_mismatch", "inconsistent", "resolve_storage");
    }
    const binding = this.#storage.get(request.workspaceId) ?? {
      storageId: request.storageRef.id,
      attachmentRef: `${this.providerId}-storage-${request.workspaceId}`,
      mountPath: "/var/lib/workspace",
      readOnly: false,
    };
    if (binding.storageId !== request.storageRef.id) {
      throw providerError("provider_storage_binding_identity_mismatch", "inconsistent", "resolve_storage");
    }
    this.#storage.set(request.workspaceId, binding);
    return structuredClone(binding);
  }

  async inspect(workspaceId: string, signal?: AbortSignal, providerId?: string): Promise<ProviderExecution | null> {
    signal?.throwIfAborted();
    this.assertProvider(providerId ?? this.providerId, "observe");
    const environment = this.#environments.get(workspaceId);
    return environment ? this.toExecution(workspaceId, environment) : null;
  }

  async observe(request: ExecutionObservationRequest): Promise<ProviderExecution | null> {
    request.signal?.throwIfAborted();
    this.assertProvider(request.providerId ?? this.providerId, "observe");
    const environment = this.#environments.get(request.workspaceId);
    if (!environment) return null;
    if (environment.ownerId !== request.expectedOwnerId) {
      throw providerError("provider_environment_owner_mismatch", "inconsistent", "observe");
    }
    return this.toExecution(request.workspaceId, environment);
  }

  async reconcile(request: ExecutionReconcileRequest): Promise<ExecutionReconcileResult> {
    request.signal?.throwIfAborted();
    assertProviderRequestSupported(this.descriptor, providerRequestFromReconcile(request), "reconcile");
    this.assertProvider(request.providerId ?? this.providerId, "reconcile");
    const previous = this.#transactions.get(request.transactionId);
    if (previous) {
      return {
        status: previous.observedState === "stopped" && request.replace && request.desiredState === "stopped"
          ? "awaiting_first_start"
          : "applied",
        generation: request.desiredGeneration,
        transactionId: request.transactionId,
        execution: structuredClone(previous),
      };
    }
    let environment = this.#environments.get(request.workspaceId);
    if (environment && environment.ownerId !== request.ownerId) {
      throw providerError("provider_environment_owner_mismatch", "inconsistent", "reconcile");
    }
    if (!environment || request.replace) {
      environment = {
        ownerId: request.ownerId,
        environmentRef: `${this.providerId}-environment-${request.workspaceId}`,
        state: request.desiredState === "running" ? "running" : "stopped",
        endpoint: new URL(`workspace/${encodeURIComponent(request.workspaceId)}/`, this.#endpointBaseUrl).href,
        createdAt: new Date().toISOString(),
        catalogSnapshot: {
          appId: request.appId,
          appVersionId: request.appRevisionId,
          imageArtifactId: request.launchArtifactId,
          imageReference: request.launchArtifactReference,
        },
      };
      this.#environments.set(request.workspaceId, environment);
    } else if (request.desiredState === "running") {
      environment.state = "running";
    } else if (environment.state === "running") {
      environment.state = "stopped";
    }
    const execution = this.toExecution(request.workspaceId, environment);
    this.#transactions.set(request.transactionId, execution);
    return {
      status: request.replace && request.desiredState === "stopped" ? "awaiting_first_start" : "applied",
      generation: request.desiredGeneration,
      transactionId: request.transactionId,
      execution,
    };
  }

  async removeEnvironment(request: ExecutionEnvironmentRemovalRequest): Promise<void> {
    request.signal?.throwIfAborted();
    this.assertProvider(request.providerId ?? this.providerId, "remove");
    const environment = this.#environments.get(request.workspaceId);
    if (environment && environment.ownerId !== request.ownerId) {
      throw providerError("provider_environment_owner_mismatch", "inconsistent", "remove");
    }
    this.#environments.delete(request.workspaceId);
    for (const [transactionId, execution] of this.#transactions) {
      if (execution.workspaceId === request.workspaceId) this.#transactions.delete(transactionId);
    }
  }

  async releaseWorkspaceStorage(request: WorkspaceStorageReleaseRequest): Promise<void> {
    request.signal?.throwIfAborted();
    assertProviderStorageSupported(this.descriptor, request.storageRef.storageClass, "release_storage");
    this.assertProvider(request.providerId, "release_storage");
    if (request.binding.storageId !== request.storageRef.id) {
      throw providerError("provider_storage_release_identity_mismatch", "inconsistent", "release_storage");
    }
    this.#storage.delete(request.workspaceId);
  }

  async resolveAccessTarget(request: AccessTargetRequest): Promise<AccessTarget> {
    request.signal?.throwIfAborted();
    this.assertProvider(request.providerId ?? this.providerId, "resolve_target");
    const environment = this.#environments.get(request.workspaceId);
    if (!environment) {
      throw providerNotFound("provider_environment_not_found", "resolve_target");
    }
    if (environment.state !== "running") {
      throw providerError("provider_access_target_unavailable", "transient", "resolve_target", 1_000);
    }
    if (environment.ownerId !== request.expectedOwnerId) {
      throw providerError("provider_environment_owner_mismatch", "inconsistent", "resolve_target");
    }
    return {
      providerId: this.providerId,
      environmentRef: environment.environmentRef,
      logicalService: request.logicalService,
      url: new URL(environment.endpoint),
      expiresAt: null,
      authority: new URL(environment.endpoint).host,
    };
  }

  async acceptDeferredExecution(
    workspaceId: string,
    ownerId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<"accepted" | "already_baseline" | "not_found"> {
    signal?.throwIfAborted();
    this.assertProvider(providerId ?? this.providerId, "reconcile");
    const environment = this.#environments.get(workspaceId);
    if (!environment) return "not_found";
    if (environment.ownerId !== ownerId) throw providerError("provider_environment_owner_mismatch", "inconsistent", "reconcile");
    return "accepted";
  }

  async inspectTransaction(
    workspaceId: string,
    transactionId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<ExecutionTransactionInspection | null> {
    signal?.throwIfAborted();
    this.assertProvider(providerId ?? this.providerId, "observe");
    const execution = this.#transactions.get(transactionId);
    if (!execution || execution.workspaceId !== workspaceId) {
      return { status: "not_found", execution: null };
    }
    return { status: "committed", execution: structuredClone(execution) };
  }

  async readMetrics(
    workspaceId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<ProviderCapabilityResult<ContainerActivityMetrics>> {
    signal?.throwIfAborted();
    this.assertProvider(providerId ?? this.providerId, "diagnose");
    if (this.#metricsMode === "unsupported") return { status: "unsupported" };
    if (this.#metricsMode === "unavailable") {
      return { status: "unavailable", error: providerError("provider_metrics_unavailable", "transient", "diagnose", 1_000) };
    }
    if (!this.#environments.has(workspaceId)) return { status: "unavailable", error: providerError("provider_environment_not_found", "transient", "diagnose") };
    return { status: "supported", value: { networkRxBytes: 0, networkTxBytes: 0, cpuPercent: 0, memoryWorkingSetBytes: 0, pids: 1 } };
  }

  async readDiagnostics(
    workspaceId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<ProviderCapabilityResult<ContainerFailureDiagnostics>> {
    signal?.throwIfAborted();
    this.assertProvider(providerId ?? this.providerId, "diagnose");
    if (this.#diagnosticsMode === "unsupported") return { status: "unsupported" };
    if (this.#diagnosticsMode === "unavailable") {
      return { status: "unavailable", error: providerError("provider_diagnostics_unavailable", "transient", "diagnose", 1_000) };
    }
    if (!this.#environments.has(workspaceId)) return { status: "unavailable", error: providerError("provider_environment_not_found", "transient", "diagnose") };
    return {
      status: "supported",
      value: {
        containerRole: "canonical",
        exitCode: null,
        oomKilled: false,
        health: "ok",
        memoryLimit: null,
        memorySwapLimit: null,
        cpus: null,
        pidsLimit: null,
        logTail: null,
      },
    };
  }

  async readProviderHealth(providerId?: string): Promise<ProviderCapabilityResult<{
    providerId: string;
    available: boolean;
    version?: string;
    host?: string;
    platform?: string;
    architecture?: string;
  }>> {
    this.assertProvider(providerId ?? this.providerId, "diagnose");
    if (this.#healthMode === "unsupported") return { status: "unsupported" };
    if (this.#healthMode === "unavailable") {
      return { status: "unavailable", error: providerError("provider_unavailable", "transient", "diagnose", 5_000) };
    }
    return { status: "supported", value: { providerId: this.providerId, available: true, version: "contract-1" } };
  }

  private toExecution(workspaceId: string, environment: ContractEnvironment): ProviderExecution {
    return {
      workspaceId,
      ownerId: environment.ownerId,
      environmentRef: environment.environmentRef,
      providerId: this.providerId,
      observedState: environment.state,
      createdAt: environment.createdAt,
      ...(environment.catalogSnapshot ? { catalogSnapshot: structuredClone(environment.catalogSnapshot) } : {}),
    };
  }

  private assertProvider(providerId: string, phase: ProviderOperationPhase): void {
    if (providerId !== this.providerId) throw providerError("provider_identity_mismatch", "inconsistent", phase);
  }
}

/** Alias emphasizes that this adapter is intended for deterministic contract tests. */
export class InMemoryExecutionProviderAdapter extends ContractProviderAdapter {}

function providerError(
  code: string,
  failureClass: "transient" | "permanent" | "inconsistent" | "cancelled",
  phase: ProviderOperationPhase,
  retryAfterMs?: number,
): ProviderOperationError {
  return new ProviderOperationError(code, failureClass, phase, retryAfterMs);
}

function normalizeProviderId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(normalized)) throw new Error("invalid_provider_id");
  return normalized;
}

function normalizeExecutionContracts(values: readonly string[]): string[] {
  if (!Array.isArray(values)) throw new Error("invalid_execution_contracts");
  const normalized = values.map((value) => {
    const contract = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(contract)) throw new Error("invalid_execution_contracts");
    return contract;
  });
  if (normalized.length === 0 || new Set(normalized).size !== normalized.length) {
    throw new Error("invalid_execution_contracts");
  }
  return normalized;
}

function trustedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_provider_endpoint");
  if (url.username || url.password || url.hash) throw new Error("invalid_provider_endpoint");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
