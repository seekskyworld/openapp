import type {
  ContainerActivityMetrics,
  ContainerCatalogSnapshot,
  ContainerFailureDiagnostics,
  ContainerLaunchProfile,
  StorageBinding,
} from "./runtime.js";
import type { WorkspaceObservedState, WorkspaceStorageRef } from "./workspace-execution.js";

export type ProviderFailureClass = "transient" | "permanent" | "inconsistent" | "cancelled";
export type ProviderOperationPhase =
  | "observe"
  | "reconcile"
  | "resolve_storage"
  | "resolve_target"
  | "remove"
  | "release_storage"
  | "diagnose";

export class ProviderOperationError extends Error {
  constructor(
    readonly code: string,
    readonly failureClass: ProviderFailureClass,
    readonly phase: ProviderOperationPhase,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export interface ProviderExecution {
  workspaceId: string;
  ownerId: string;
  environmentRef: string;
  /** Provider that owns the Environment; optional during the legacy projection cutover. */
  providerId?: string;
  observedState: WorkspaceObservedState;
  createdAt: string;
  catalogSnapshot?: ContainerCatalogSnapshot;
  transactionRecovered?: boolean;
}

export interface ExecutionReconcileRequest {
  workspaceId: string;
  ownerId: string;
  /** Fixed by the control plane from the Workspace execution projection. */
  providerId?: string;
  /** 代码拥有的制品类型；旧调用方省略时按 OCI 镜像兼容处理。 */
  artifactKind?: string;
  /** App/Revision 执行合同；不能从 Docker profile 反向推断。 */
  executionContract?: string | null;
  /** 控制面选定的稳定 Workspace 存储类别。 */
  storageClass?: string;
  appId: string;
  appRevisionId: string | null;
  launchArtifactId: string | null;
  launchArtifactReference: string;
  sourceCatalogSnapshot?: ContainerCatalogSnapshot;
  launchProfile: ContainerLaunchProfile;
  storageBindings: readonly StorageBinding[];
  desiredState: "running" | "stopped";
  desiredGeneration: number;
  transactionId: string;
  replace: boolean;
  signal?: AbortSignal;
}

export interface ExecutionObservationRequest {
  workspaceId: string;
  expectedOwnerId: string;
  /** Routed adapters use this to avoid cross-provider probing. */
  providerId?: string;
  storageBindings: readonly StorageBinding[];
  signal?: AbortSignal;
}

export interface ExecutionEnvironmentRemovalRequest {
  workspaceId: string;
  ownerId: string;
  providerId?: string;
  storageBindings: readonly StorageBinding[];
  signal?: AbortSignal;
}

export interface StorageBindingResolutionRequest {
  workspaceId: string;
  ownerId: string;
  providerId: string;
  storageRef: WorkspaceStorageRef;
  signal?: AbortSignal;
}

export interface WorkspaceStorageBindingResolver {
  resolveStorageBinding(request: StorageBindingResolutionRequest): Promise<StorageBinding>;
}

export interface WorkspaceStorageReleaseRequest extends StorageBindingResolutionRequest {
  binding: StorageBinding;
}

export interface WorkspaceStorageReleasePort {
  readonly providerId: string;
  releaseWorkspaceStorage(request: WorkspaceStorageReleaseRequest): Promise<void>;
}

export type ExecutionReconcileStatus = "progressing" | "applied" | "awaiting_first_start" | "rolled_back";

export interface ExecutionReconcileResult {
  status: ExecutionReconcileStatus;
  generation: number;
  transactionId: string;
  execution: ProviderExecution;
}

export interface ExecutionControlPort {
  readonly providerId: string;
  inspect(workspaceId: string, signal?: AbortSignal, providerId?: string): Promise<ProviderExecution | null>;
  observe(request: ExecutionObservationRequest): Promise<ProviderExecution | null>;
  reconcile(request: ExecutionReconcileRequest): Promise<ExecutionReconcileResult>;
  removeEnvironment(request: ExecutionEnvironmentRemovalRequest): Promise<void>;
}

export interface ExecutionTransactionInspection {
  status: "pending" | "committed" | "not_found" | "inconsistent";
  execution: ProviderExecution | null;
}

export interface ExecutionTransactionPort {
  acceptDeferredExecution(
    workspaceId: string,
    ownerId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<"accepted" | "already_baseline" | "not_found">;
  inspectTransaction(
    workspaceId: string,
    transactionId: string,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<ExecutionTransactionInspection | null>;
}

export type WorkspaceLogicalService = "workspace_ui" | "mcp_sandbox_asset";

export interface AccessTarget {
  providerId: string;
  environmentRef: string;
  logicalService: WorkspaceLogicalService;
  url: URL;
  expiresAt: string | null;
  /** Provider 路由需要的 authority；浏览器 Host 不能覆盖它。 */
  authority?: string;
  /** 仅存在于服务端内存的短期凭证；同名浏览器 Header 必须被覆盖。 */
  headers?: Readonly<Record<string, string>>;
}

export interface AccessTargetRequest {
  workspaceId: string;
  expectedOwnerId: string;
  providerId?: string;
  logicalService: WorkspaceLogicalService;
  signal?: AbortSignal;
}

export interface AccessTargetResolver {
  resolveAccessTarget(request: AccessTargetRequest): Promise<AccessTarget>;
}

export type ProviderCapabilityResult<T> =
  | { status: "supported"; value: T }
  | { status: "unsupported" }
  | { status: "unavailable"; error: ProviderOperationError };

export interface ProviderMetricsPort {
  readMetrics(workspaceId: string, signal?: AbortSignal, providerId?: string): Promise<ProviderCapabilityResult<ContainerActivityMetrics>>;
}

export interface ProviderDiagnosticsPort {
  readDiagnostics(workspaceId: string, signal?: AbortSignal, providerId?: string): Promise<ProviderCapabilityResult<ContainerFailureDiagnostics>>;
}

export interface ProviderHealthPort {
  readProviderHealth(providerId?: string): Promise<ProviderCapabilityResult<{
    providerId: string;
    available: boolean;
    version?: string;
    host?: string;
    platform?: string;
    architecture?: string;
  }>>;
}

/**
 * 组合根使用的规范执行端口集合。类型放在领域端口模块，调用方无需依赖
 * 具体 Provider adapter 或 registry 实现。
 */
export type ExecutionProviderPorts = ExecutionControlPort
  & ExecutionTransactionPort
  & WorkspaceStorageBindingResolver
  & WorkspaceStorageReleasePort
  & AccessTargetResolver
  & ProviderMetricsPort
  & ProviderDiagnosticsPort
  & ProviderHealthPort;
