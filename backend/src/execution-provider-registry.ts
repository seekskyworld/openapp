import type {
  AccessTarget,
  AccessTargetRequest,
  AccessTargetResolver,
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
  StorageBindingResolutionRequest,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort,
  WorkspaceStorageReleaseRequest,
} from "./execution-provider.js";
import type { ContainerActivityMetrics, ContainerFailureDiagnostics, StorageBinding } from "./runtime.js";
import {
  assertProviderRequestSupported,
  providerRequestFromReconcile,
} from "./provider-adapter-contract.js";
import { GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT } from "./runtime-contracts.js";

export type ProviderEnvironmentKind = "container" | "microvm" | "vm" | "host_process" | "opaque";
export type ProviderWorkloadClass = "sandbox" | "dedicated";
export type ProviderAccessMode = "direct_http" | "provider_proxy" | "tunnel";
export type ProviderRollbackCapability = "transactional" | "best_effort" | "none";
export type ProviderHealthCapability = "native" | "probe" | "none";

export interface ProviderCapabilities {
  rollback: ProviderRollbackCapability;
  workloadHealth: ProviderHealthCapability;
  metrics: boolean;
  diagnostics: boolean;
}

/** Versioned, code-owned Provider contract. It describes capabilities, not inheritance. */
export interface ProviderDescriptor {
  descriptorVersion: 1;
  id: string;
  environmentKind: ProviderEnvironmentKind;
  workloadClass: ProviderWorkloadClass;
  accessMode: ProviderAccessMode;
  supportedArtifactKinds: readonly string[];
  supportedExecutionContracts: readonly string[];
  supportedStorageClasses: readonly string[];
  resourceLimits: {
    minMemoryBytes?: number;
    maxMemoryBytes?: number;
    minCpuMillis?: number;
    maxCpuMillis?: number;
    minPidsLimit?: number;
    maxPidsLimit?: number;
  };
  capabilities: ProviderCapabilities;
}

/**
 * A Provider adapter owns execution, storage attachment and access resolution.
 * Optional capability ports are deliberately separate so callers can report
 * `unsupported` without widening the lifecycle contract.
 */
export interface ExecutionProviderAdapter
  extends ExecutionControlPort,
    WorkspaceStorageBindingResolver,
    WorkspaceStorageReleasePort,
    AccessTargetResolver {
  readonly descriptor: ProviderDescriptor;
  readonly acceptDeferredExecution?: ExecutionTransactionPort["acceptDeferredExecution"];
  readonly inspectTransaction?: ExecutionTransactionPort["inspectTransaction"];
  readonly readMetrics?: ProviderMetricsPort["readMetrics"];
  readonly readDiagnostics?: ProviderDiagnosticsPort["readDiagnostics"];
  readonly readProviderHealth?: ProviderHealthPort["readProviderHealth"];
}

/** Input accepted during the additive migration when a legacy adapter has no descriptor yet. */
export type ExecutionProviderAdapterInput = Omit<ExecutionProviderAdapter, "descriptor"> & {
  readonly descriptor?: ProviderDescriptor;
};

export interface ProviderSelectionRequirements {
  artifactKind?: string;
  executionContract?: string;
  storageClass?: string;
  memoryBytes?: number;
  cpuMillis?: number;
  pidsLimit?: number;
  capabilities?: Partial<ProviderCapabilities>;
}

export class ExecutionProviderRegistryError extends Error {
  constructor(readonly code: string, readonly providerId?: string) {
    super(code);
  }
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const ENVIRONMENT_KINDS = new Set<ProviderEnvironmentKind>(["container", "microvm", "vm", "host_process", "opaque"]);
const WORKLOAD_CLASSES = new Set<ProviderWorkloadClass>(["sandbox", "dedicated"]);
const ACCESS_MODES = new Set<ProviderAccessMode>(["direct_http", "provider_proxy", "tunnel"]);
const ROLLBACK_CAPABILITIES = new Set<ProviderRollbackCapability>(["transactional", "best_effort", "none"]);
const HEALTH_CAPABILITIES = new Set<ProviderHealthCapability>(["native", "probe", "none"]);

/** Immutable registry used by the composition root and by contract tests. */
export class ExecutionProviderRegistry {
  readonly #providers: ReadonlyMap<string, ExecutionProviderAdapter>;
  readonly #descriptors: ReadonlyMap<string, ProviderDescriptor>;
  readonly defaultProviderId: string;

  constructor(
    adapters: readonly ExecutionProviderAdapterInput[],
    options: { defaultProviderId?: string } = {},
  ) {
    if (adapters.length === 0) throw new ExecutionProviderRegistryError("execution_provider_required");
    const providers = new Map<string, ExecutionProviderAdapter>();
    const descriptors = new Map<string, ProviderDescriptor>();
    for (const input of adapters) {
      const adapter = adaptExecutionProvider(input);
      const providerId = normalizeProviderId(adapter.providerId, "execution_provider_invalid_id");
      if (providers.has(providerId)) {
        throw new ExecutionProviderRegistryError("execution_provider_duplicate_id", providerId);
      }
      const descriptor = validateDescriptor(adapter.descriptor, providerId);
      providers.set(providerId, adapter);
      descriptors.set(providerId, descriptor);
    }
    const defaultProviderId = normalizeProviderId(
      options.defaultProviderId ?? adapters[0]?.providerId,
      "execution_provider_invalid_default",
    );
    if (!providers.has(defaultProviderId)) {
      throw new ExecutionProviderRegistryError("execution_provider_default_not_found", defaultProviderId);
    }
    this.#providers = providers;
    this.#descriptors = descriptors;
    this.defaultProviderId = defaultProviderId;
  }

  get(providerId: string): ExecutionProviderAdapter | undefined {
    return this.#providers.get(normalizeProviderId(providerId, "execution_provider_invalid_id"));
  }

  require(providerId: string): ExecutionProviderAdapter {
    const normalized = normalizeProviderId(providerId, "execution_provider_invalid_id");
    const adapter = this.#providers.get(normalized);
    if (!adapter) throw new ExecutionProviderRegistryError("execution_provider_not_found", normalized);
    return adapter;
  }

  list(): readonly ExecutionProviderAdapter[] {
    return [...this.#providers.values()];
  }

  descriptors(): readonly ProviderDescriptor[] {
    return [...this.#descriptors.values()].map(cloneDescriptor);
  }

  descriptor(providerId: string): ProviderDescriptor {
    const normalized = normalizeProviderId(providerId, "execution_provider_invalid_id");
    const descriptor = this.#descriptors.get(normalized);
    if (!descriptor) throw new ExecutionProviderRegistryError("execution_provider_not_found", normalized);
    return cloneDescriptor(descriptor);
  }

  /** Selects only from code-registered descriptors; no request data is executed. */
  select(requirements: ProviderSelectionRequirements = {}): ExecutionProviderAdapter {
    const candidates = [...this.#providers.keys()].filter((providerId) => (
      matches(this.#descriptors.get(providerId)!, requirements)
    ));
    if (candidates.length === 0) {
      throw new ExecutionProviderRegistryError("execution_provider_unsupported");
    }
    return this.#providers.get(candidates[0]!)!;
  }

  /**
   * Checks optional health without turning an unsupported health port into an
   * outage. A Provider that is temporarily unavailable is skipped.
   */
  async selectAvailable(
    requirements: ProviderSelectionRequirements = {},
    signal?: AbortSignal,
  ): Promise<ExecutionProviderAdapter> {
    const candidates = [...this.#providers.values()].filter((adapter) => matches(adapter.descriptor, requirements));
    if (candidates.length === 0) throw new ExecutionProviderRegistryError("execution_provider_unsupported");
    let unavailable = false;
    for (const adapter of candidates) {
      signal?.throwIfAborted();
      if (!adapter.readProviderHealth) return adapter;
      let health: ProviderCapabilityResult<{
        providerId: string;
        available: boolean;
        version?: string;
        host?: string;
        platform?: string;
        architecture?: string;
      }>;
      try {
        health = await adapter.readProviderHealth(adapter.providerId);
      } catch {
        // 健康探针本身失败只能说明候选暂时不可达；不能把异常泄漏成未分类错误，
        // 也不能因此跳到另一个已经固定 pin 的 Workspace Provider。
        signal?.throwIfAborted();
        unavailable = true;
        continue;
      }
      if (health.status === "supported" && health.value.available) return adapter;
      if (health.status === "unavailable" || (health.status === "supported" && !health.value.available)) {
        unavailable = true;
      }
    }
    throw new ExecutionProviderRegistryError(
      unavailable ? "execution_provider_unavailable" : "execution_provider_unsupported",
    );
  }

  /** Creates the routing facade used by Portal Core. */
  router(options: {
    defaultProviderId?: string;
    resolveProviderId?: (workspaceId: string) => string | null | undefined | Promise<string | null | undefined>;
  } = {}): RoutedExecutionProvider {
    return new RoutedExecutionProvider(this, options);
  }
}

/**
 * A narrow routing facade. The Workspace projection supplies the Provider pin;
 * the facade never probes another Provider after a pin is known.
 */
export class RoutedExecutionProvider
  implements
    ExecutionControlPort,
    ExecutionTransactionPort,
    WorkspaceStorageBindingResolver,
    WorkspaceStorageReleasePort,
    AccessTargetResolver,
    ProviderMetricsPort,
    ProviderDiagnosticsPort,
    ProviderHealthPort {
  readonly providerId: string;
  readonly #registry: ExecutionProviderRegistry;
  readonly #resolveProviderId: ((workspaceId: string) => string | null | undefined | Promise<string | null | undefined>) | undefined;

  constructor(
    registry: ExecutionProviderRegistry,
    options: {
      defaultProviderId?: string;
      resolveProviderId?: (workspaceId: string) => string | null | undefined | Promise<string | null | undefined>;
    } = {},
  ) {
    this.#registry = registry;
    this.providerId = options.defaultProviderId ?? registry.defaultProviderId;
    registry.require(this.providerId);
    this.#resolveProviderId = options.resolveProviderId;
  }

  async inspect(workspaceId: string, signal?: AbortSignal, providerId?: string): Promise<ProviderExecution | null> {
    return (await this.#adapter(workspaceId, providerId, signal)).inspect(workspaceId, signal, providerId);
  }

  async observe(request: ExecutionObservationRequest): Promise<ProviderExecution | null> {
    return (await this.#adapter(request.workspaceId, request.providerId, request.signal)).observe(request);
  }

  async reconcile(request: ExecutionReconcileRequest): Promise<ExecutionReconcileResult> {
    const adapter = await this.#adapter(request.workspaceId, request.providerId, request.signal);
    // 所有 Provider 在产生副作用前共享同一份合同校验；适配器仍会再次校验，
    // 以防绕过路由 facade 的直接调用方破坏边界。
    assertProviderRequestSupported(adapter.descriptor, providerRequestFromReconcile(request));
    return adapter.reconcile(request);
  }

  async removeEnvironment(request: ExecutionEnvironmentRemovalRequest): Promise<void> {
    return (await this.#adapter(request.workspaceId, request.providerId, request.signal)).removeEnvironment(request);
  }

  async resolveStorageBinding(request: StorageBindingResolutionRequest): Promise<StorageBinding> {
    return this.#registry.require(request.providerId).resolveStorageBinding(request);
  }

  async releaseWorkspaceStorage(request: WorkspaceStorageReleaseRequest): Promise<void> {
    return this.#registry.require(request.providerId).releaseWorkspaceStorage(request);
  }

  async resolveAccessTarget(request: AccessTargetRequest): Promise<AccessTarget> {
    return (await this.#adapter(request.workspaceId, request.providerId, request.signal)).resolveAccessTarget(request);
  }

  async acceptDeferredExecution(
    workspaceId: string,
    ownerId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<"accepted" | "already_baseline" | "not_found"> {
    const adapter = await this.#adapter(workspaceId, providerId, signal);
    return adapter.acceptDeferredExecution
      ? adapter.acceptDeferredExecution(workspaceId, ownerId, signal, providerId)
      : "not_found";
  }

  async inspectTransaction(
    workspaceId: string,
    transactionId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<ExecutionTransactionInspection | null> {
    const adapter = await this.#adapter(workspaceId, providerId, signal);
    return adapter.inspectTransaction
      ? adapter.inspectTransaction(workspaceId, transactionId, signal, providerId)
      : null;
  }

  async readMetrics(
    workspaceId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<ProviderCapabilityResult<ContainerActivityMetrics>> {
    const adapter = await this.#adapter(workspaceId, providerId, signal);
    return adapter.readMetrics ? adapter.readMetrics(workspaceId, signal, providerId) : { status: "unsupported" };
  }

  async readDiagnostics(
    workspaceId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<ProviderCapabilityResult<ContainerFailureDiagnostics>> {
    const adapter = await this.#adapter(workspaceId, providerId, signal);
    return adapter.readDiagnostics ? adapter.readDiagnostics(workspaceId, signal, providerId) : { status: "unsupported" };
  }

  async readProviderHealth(providerId = this.providerId): Promise<ProviderCapabilityResult<{
    providerId: string;
    available: boolean;
    version?: string;
    host?: string;
    platform?: string;
    architecture?: string;
  }>> {
    const adapter = this.#registry.require(providerId);
    return adapter.readProviderHealth
      ? adapter.readProviderHealth(providerId)
      : { status: "unsupported" };
  }

  async #adapter(workspaceId: string, explicitProviderId?: string, signal?: AbortSignal): Promise<ExecutionProviderAdapter> {
    signal?.throwIfAborted();
    const selected = explicitProviderId
      ?? (this.#resolveProviderId ? await this.#resolveProviderId(workspaceId) : undefined)
      ?? this.providerId;
    signal?.throwIfAborted();
    return this.#registry.require(selected);
  }
}

/**
 * Adds a conservative descriptor to a pre-registry adapter without mutating
 * the supplied instance. Existing custom test/runtime adapters can therefore
 * join the registry before they grow an explicit descriptor property.
 */
export function adaptExecutionProvider(input: ExecutionProviderAdapterInput): ExecutionProviderAdapter {
  if (input.descriptor) return input as ExecutionProviderAdapter;
  const providerId = input.providerId;
  return {
    providerId,
    descriptor: defaultDescriptor(providerId),
    inspect: input.inspect.bind(input),
    observe: input.observe.bind(input),
    reconcile: input.reconcile.bind(input),
    removeEnvironment: input.removeEnvironment.bind(input),
    resolveStorageBinding: input.resolveStorageBinding.bind(input),
    releaseWorkspaceStorage: input.releaseWorkspaceStorage.bind(input),
    resolveAccessTarget: input.resolveAccessTarget.bind(input),
    ...(input.acceptDeferredExecution ? { acceptDeferredExecution: input.acceptDeferredExecution.bind(input) } : {}),
    ...(input.inspectTransaction ? { inspectTransaction: input.inspectTransaction.bind(input) } : {}),
    ...(input.readMetrics ? { readMetrics: input.readMetrics.bind(input) } : {}),
    ...(input.readDiagnostics ? { readDiagnostics: input.readDiagnostics.bind(input) } : {}),
    ...(input.readProviderHealth ? { readProviderHealth: input.readProviderHealth.bind(input) } : {}),
  };
}

function matches(descriptor: ProviderDescriptor, requirements: ProviderSelectionRequirements): boolean {
  if (requirements.artifactKind && !descriptor.supportedArtifactKinds.includes(requirements.artifactKind)) return false;
  if (requirements.executionContract && !descriptor.supportedExecutionContracts.includes(requirements.executionContract)) return false;
  if (requirements.storageClass && !descriptor.supportedStorageClasses.includes(requirements.storageClass)) return false;
  if (requirements.memoryBytes !== undefined && (!Number.isSafeInteger(requirements.memoryBytes) || requirements.memoryBytes <= 0)) return false;
  if (requirements.cpuMillis !== undefined && (!Number.isSafeInteger(requirements.cpuMillis) || requirements.cpuMillis <= 0)) return false;
  if (requirements.pidsLimit !== undefined && (!Number.isSafeInteger(requirements.pidsLimit) || requirements.pidsLimit <= 0)) return false;
  const limits = descriptor.resourceLimits;
  if (requirements.memoryBytes !== undefined
    && ((limits.minMemoryBytes !== undefined && requirements.memoryBytes < limits.minMemoryBytes)
      || (limits.maxMemoryBytes !== undefined && requirements.memoryBytes > limits.maxMemoryBytes))) return false;
  if (requirements.cpuMillis !== undefined
    && ((limits.minCpuMillis !== undefined && requirements.cpuMillis < limits.minCpuMillis)
      || (limits.maxCpuMillis !== undefined && requirements.cpuMillis > limits.maxCpuMillis))) return false;
  if (requirements.pidsLimit !== undefined
    && ((limits.minPidsLimit !== undefined && requirements.pidsLimit < limits.minPidsLimit)
      || (limits.maxPidsLimit !== undefined && requirements.pidsLimit > limits.maxPidsLimit))) return false;
  const capabilities = requirements.capabilities;
  if (capabilities) {
    if (capabilities.rollback && capabilities.rollback !== descriptor.capabilities.rollback) return false;
    if (capabilities.workloadHealth && capabilities.workloadHealth !== descriptor.capabilities.workloadHealth) return false;
    if (capabilities.metrics !== undefined && capabilities.metrics !== descriptor.capabilities.metrics) return false;
    if (capabilities.diagnostics !== undefined && capabilities.diagnostics !== descriptor.capabilities.diagnostics) return false;
  }
  return true;
}

function validateDescriptor(value: ProviderDescriptor, providerId: string): ProviderDescriptor {
  if (!value || value.descriptorVersion !== 1 || value.id !== providerId
    || !ENVIRONMENT_KINDS.has(value.environmentKind)
    || !WORKLOAD_CLASSES.has(value.workloadClass)
    || !ACCESS_MODES.has(value.accessMode)
    || !Array.isArray(value.supportedArtifactKinds)
    || !Array.isArray(value.supportedExecutionContracts)
    || !Array.isArray(value.supportedStorageClasses)
    || !value.capabilities
    || !ROLLBACK_CAPABILITIES.has(value.capabilities.rollback)
    || !HEALTH_CAPABILITIES.has(value.capabilities.workloadHealth)
    || typeof value.capabilities.metrics !== "boolean"
    || typeof value.capabilities.diagnostics !== "boolean") {
    throw new ExecutionProviderRegistryError("execution_provider_invalid_descriptor", providerId);
  }
  const arrays = [value.supportedArtifactKinds, value.supportedExecutionContracts, value.supportedStorageClasses];
  if (arrays.some((items) => items.some((item) => typeof item !== "string" || !item.trim() || item.length > 128))) {
    throw new ExecutionProviderRegistryError("execution_provider_invalid_descriptor", providerId);
  }
  const limits = value.resourceLimits;
  if (!limits || typeof limits !== "object" || Object.entries(limits).some(([key, item]) => (
    !["minMemoryBytes", "maxMemoryBytes", "minCpuMillis", "maxCpuMillis", "minPidsLimit", "maxPidsLimit"].includes(key)
    || (item !== undefined && (!Number.isSafeInteger(item) || item <= 0))
  ))) {
    throw new ExecutionProviderRegistryError("execution_provider_invalid_descriptor", providerId);
  }
  if (limits.minMemoryBytes !== undefined && limits.maxMemoryBytes !== undefined && limits.minMemoryBytes > limits.maxMemoryBytes) {
    throw new ExecutionProviderRegistryError("execution_provider_invalid_descriptor", providerId);
  }
  if (limits.minCpuMillis !== undefined && limits.maxCpuMillis !== undefined && limits.minCpuMillis > limits.maxCpuMillis) {
    throw new ExecutionProviderRegistryError("execution_provider_invalid_descriptor", providerId);
  }
  if (limits.minPidsLimit !== undefined && limits.maxPidsLimit !== undefined && limits.minPidsLimit > limits.maxPidsLimit) {
    throw new ExecutionProviderRegistryError("execution_provider_invalid_descriptor", providerId);
  }
  return cloneDescriptor(value);
}

function cloneDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  return {
    ...descriptor,
    supportedArtifactKinds: [...descriptor.supportedArtifactKinds],
    supportedExecutionContracts: [...descriptor.supportedExecutionContracts],
    supportedStorageClasses: [...descriptor.supportedStorageClasses],
    resourceLimits: { ...descriptor.resourceLimits },
    capabilities: { ...descriptor.capabilities },
  };
}

function normalizeProviderId(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!PROVIDER_ID_PATTERN.test(normalized)) throw new ExecutionProviderRegistryError(code);
  return normalized;
}

function defaultDescriptor(providerId: string): ProviderDescriptor {
  return {
    descriptorVersion: 1,
    id: providerId,
    environmentKind: "opaque",
    workloadClass: "dedicated",
    accessMode: "provider_proxy",
    supportedArtifactKinds: ["oci-image"],
    supportedExecutionContracts: [GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT],
    supportedStorageClasses: ["workspace-data"],
    resourceLimits: {},
    capabilities: {
      rollback: "best_effort",
      workloadHealth: "none",
      metrics: false,
      diagnostics: false,
    },
  };
}
