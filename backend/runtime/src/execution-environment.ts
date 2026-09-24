import type {
  ContainerActivityMetrics,
  ContainerFailureDiagnostics,
  ContainerInstance,
  ContainerLaunchProfile,
  ContainerRuntime,
  DeferredCandidateAcceptance,
  ProvisionContainerRequest,
  StorageBinding,
} from "./container-runtime.js";

/**
 * Provider-neutral description of the object that executes one Workspace.
 * `kind` is metadata only; adapters do not form a Container/Sandbox/VM
 * inheritance tree because a provider may implement more than one kind.
 */
export type ExecutionEnvironmentKind = "container" | "microvm" | "vm" | "host_process" | "opaque";

export interface ExecutionEnvironmentDescriptor {
  readonly providerId: string;
  readonly kind: ExecutionEnvironmentKind;
  readonly contract: string;
  readonly accessMode: "direct_http" | "provider_proxy" | "tunnel";
}

/** The lifecycle surface used by Core; provider-specific methods stay optional. */
export interface ExecutionEnvironment {
  readonly descriptor?: ExecutionEnvironmentDescriptor;
  provision(request: ProvisionContainerRequest): Promise<ContainerInstance>;
  get(instanceId: string, signal?: AbortSignal, storageBindings?: readonly StorageBinding[]): Promise<ContainerInstance | null>;
  start(instanceId: string, signal?: AbortSignal, storageBindings?: readonly StorageBinding[]): Promise<ContainerInstance>;
  stop(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance>;
  sampleActivity(instanceId: string, signal?: AbortSignal): Promise<ContainerActivityMetrics>;
  remove(instanceId: string, ownerId: string, signal?: AbortSignal): Promise<void>;
  rebuild?(request: ProvisionContainerRequest): Promise<ContainerInstance>;
  observe?(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance | null>;
  diagnose?(instanceId: string, signal?: AbortSignal): Promise<ContainerFailureDiagnostics>;
  acceptDeferredCandidate?(instanceId: string, ownerId: string, signal?: AbortSignal): Promise<DeferredCandidateAcceptance>;
  status?(): Promise<{ runtime: string; available: boolean; version?: string; host?: string; platform?: string; architecture?: string; error?: string }>;
}

/**
 * Adapts the legacy ContainerRuntime to the neutral execution contract. The
 * wrapper deliberately delegates every operation, so changing the Core
 * vocabulary cannot alter Docker lifecycle or Volume behavior.
 */
export class ContainerRuntimeExecutionEnvironment implements ExecutionEnvironment {
  readonly descriptor: ExecutionEnvironmentDescriptor;
  readonly #runtime: ContainerRuntime;

  constructor(runtime: ContainerRuntime, descriptor: ExecutionEnvironmentDescriptor) {
    this.#runtime = runtime;
    this.descriptor = { ...descriptor };
  }

  provision(request: ProvisionContainerRequest): Promise<ContainerInstance> {
    return this.#runtime.provision(request);
  }

  get(instanceId: string, signal?: AbortSignal, storageBindings?: readonly StorageBinding[]): Promise<ContainerInstance | null> {
    return this.#runtime.get(instanceId, signal, storageBindings);
  }

  start(instanceId: string, signal?: AbortSignal, storageBindings?: readonly StorageBinding[]): Promise<ContainerInstance> {
    return this.#runtime.start(instanceId, signal, storageBindings);
  }

  stop(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance> {
    return this.#runtime.stop(instanceId, signal);
  }

  sampleActivity(instanceId: string, signal?: AbortSignal): Promise<ContainerActivityMetrics> {
    return this.#runtime.sampleActivity(instanceId, signal);
  }

  remove(instanceId: string, ownerId: string, signal?: AbortSignal): Promise<void> {
    return this.#runtime.remove(instanceId, ownerId, signal);
  }

  rebuild(request: ProvisionContainerRequest): Promise<ContainerInstance> {
    if (!this.#runtime.rebuild) throw new Error("execution_environment_rebuild_unsupported");
    return this.#runtime.rebuild(request);
  }

  observe(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance | null> {
    return this.#runtime.observe ? this.#runtime.observe(instanceId, signal) : this.#runtime.get(instanceId, signal);
  }

  diagnose(instanceId: string, signal?: AbortSignal): Promise<ContainerFailureDiagnostics> {
    if (!this.#runtime.diagnose) throw new Error("execution_environment_diagnostics_unsupported");
    return this.#runtime.diagnose(instanceId, signal);
  }

  acceptDeferredCandidate(instanceId: string, ownerId: string, signal?: AbortSignal): Promise<DeferredCandidateAcceptance> {
    if (!this.#runtime.acceptDeferredCandidate) throw new Error("execution_environment_deferred_candidate_unsupported");
    return this.#runtime.acceptDeferredCandidate(instanceId, ownerId, signal);
  }

  status() {
    if (!this.#runtime.status) throw new Error("execution_environment_status_unsupported");
    return this.#runtime.status();
  }
}

/** 不需要产品专用钩子的 Provider 使用的通用合同标记。 */
export const GENERIC_EXECUTION_CONTRACT = "generic-v1";
