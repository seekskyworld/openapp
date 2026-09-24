export type ContainerState = "creating" | "running" | "stopped" | "failed";

/** 通用 App Runtime 的默认合同；具体 App 可在 manifest 中声明自己的版本。 */
export const GENERIC_RUNTIME_CONTRACT = "generic-v1";
export const NO_RUNTIME_CONTRACT = "none";

export interface ContainerConfigFile {
  /** 相对于 Adapter 声明的持久化根目录的 POSIX 路径。 */
  path: string;
  content: string;
}

export interface ContainerLaunchProfile {
  imageReference: string;
  resources: {
    memory: string;
    cpus: string;
    pidsLimit: number;
  };
  environment: Readonly<Record<string, string>>;
  configFiles: readonly ContainerConfigFile[];
}

export interface ContainerCatalogSnapshot {
  appId: string;
  appVersionId: string | null;
  imageArtifactId: string | null;
  imageReference: string;
}

/** Provider-consumable attachment resolved from a stable Workspace storage identity. */
export interface StorageBinding {
  storageId: string;
  attachmentRef: string;
  mountPath: string;
  readOnly: boolean;
}

export interface ResolveStorageBindingRequest {
  workspaceId: string;
  ownerId: string;
  storageId: string;
  storageClass: string;
  affinityProviderId?: string;
  affinityRegion?: string;
  signal?: AbortSignal;
}

export interface RemoveContainerEnvironmentRequest {
  instanceId: string;
  ownerId: string;
  storageBindings?: readonly StorageBinding[];
  signal?: AbortSignal;
}

export interface ReleaseContainerStorageRequest extends RemoveContainerEnvironmentRequest {}

export interface ProvisionContainerRequest {
  /** 服务端签发的标识；绝不能直接接受浏览器传入的值。 */
  instanceId: string;
  /** 已认证的用户标识，仅用于所有权元数据。 */
  ownerId: string;
  /** Control-plane Provider pin; Docker-compatible runtimes may ignore it. */
  providerId?: string;
  /** 已由控制面校验的 App/Revision 执行合同。 */
  executionContract?: string | null;
  /** 可选目录快照，仅用于受管 Runtime 标签。 */
  appId?: string;
  appVersionId?: string | null;
  imageArtifactId?: string | null;
  imageReference?: string | null;
  /** 控制面提供的重建回滚快照，浏览器请求不得直接传入。 */
  sourceCatalogSnapshot?: ContainerCatalogSnapshot;
  /** 控制面提供且已校验的 provision 策略快照。 */
  launchProfile?: ContainerLaunchProfile;
  /** Resolved by the control plane; raw Provider implementations must not guess storage attachments. */
  storageBindings?: readonly StorageBinding[];
  /** rebuild 可以不启动容器，以保留 stopped 状态。 */
  start?: boolean;
  /** rollout worker 签发的执行代次；仅用于受管 rebuild fencing。 */
  rebuildTransactionId?: string;
  /** 控制面 lease 丢失时中止本代次，避免继续发出 Docker 副作用。 */
  signal?: AbortSignal;
}

export interface ContainerInstance {
  instanceId: string;
  ownerId: string;
  /** Provider identity when an adapter is routed through a registry. */
  providerId?: string;
  runtimeId: string;
  state: ContainerState;
  endpoint: string | null;
  createdAt: string;
  /** 从实际 Runtime 代次标签中回读的不可变目录快照。 */
  catalogSnapshot?: ContainerCatalogSnapshot;
  /** Runtime 已完成一次受管 rebuild 残留恢复；仅供控制面本次同步使用。 */
  rebuildRecovered?: boolean;
}

/**
 * Docker 当前 artifacts 对指定 rebuild 代次的证明结果。`not_found` 只表示
 * 证明已不存在；调用方必须结合持久化 source/target 快照判断是否已回滚。
 */
export type ContainerRebuildTransactionStatus =
  | "pending"
  | "committed"
  | "not_found"
  | "inconsistent";

export interface ContainerRebuildTransactionInspection {
  status: ContainerRebuildTransactionStatus;
  instance: ContainerInstance | null;
}

export type DeferredCandidateAcceptance = "accepted" | "already_baseline" | "not_found";

export class ContainerRebuildRollbackError extends Error {
  readonly recoveredInstance: ContainerInstance;

  constructor(cause: unknown, recoveredInstance: ContainerInstance) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message || "container rebuild rolled back", { cause });
    this.name = "ContainerRebuildRollbackError";
    this.recoveredInstance = recoveredInstance;
  }
}

export type ContainerArtifactValidationFailure = "invalid" | "unsupported";

/** Stable validation result that can be distinguished from Docker availability failures. */
export class ContainerArtifactValidationError extends Error {
  constructor(
    readonly code: string,
    readonly failure: ContainerArtifactValidationFailure,
  ) {
    super(code);
    this.name = "ContainerArtifactValidationError";
  }
}

export interface ContainerActivityMetrics {
  /** 容器启动以来累计接收的字节数。 */
  networkRxBytes: number;
  /** 容器启动以来累计发送的字节数。 */
  networkTxBytes: number;
  cpuPercent: number;
  memoryWorkingSetBytes: number;
  pids: number;
  /** 仅当 Runtime 提供真实 GPU 监控时存在。 */
  gpuUtilizationPercent?: number;
}

/** Read-only diagnostics captured after a failed or unhealthy container run. */
export interface ContainerFailureDiagnostics {
  containerRole: "canonical" | "rollback" | "candidate" | "previous";
  exitCode: number | null;
  oomKilled: boolean | null;
  health: string | null;
  memoryLimit: string | null;
  memorySwapLimit: string | null;
  cpus: string | null;
  pidsLimit: number | null;
  logTail: string | null;
}

/**
 * Portal 应用服务使用的基础设施端口。实现负责全部镜像、网络、Volume 和
 * 资源策略，调用方不能覆盖这些策略。
 */
export interface ContainerRuntime {
  resolveStorageBinding?(request: ResolveStorageBindingRequest): Promise<StorageBinding>;
  provision(request: ProvisionContainerRequest): Promise<ContainerInstance>;
  /** Observe the canonical container without recovering or mutating rebuild artifacts. */
  observe?(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance | null>;
  get(
    instanceId: string,
    signal?: AbortSignal,
    storageBindings?: readonly StorageBinding[],
  ): Promise<ContainerInstance | null>;
  start(
    instanceId: string,
    signal?: AbortSignal,
    storageBindings?: readonly StorageBinding[],
  ): Promise<ContainerInstance>;
  stop(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance>;
  /** 使用新 profile 重建容器，同时保留受管存储。 */
  rebuild?(request: ProvisionContainerRequest): Promise<ContainerInstance>;
  /**
   * 接受最新停止候选作为后续任务批次的重建基线；不会启动容器或删除共享 Volume。
   */
  acceptDeferredCandidate?(
    instanceId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<DeferredCandidateAcceptance>;
  /** 只读检查受管 Docker artifacts 能否证明指定 rebuild 代次。 */
  inspectRebuildTransaction?(
    instanceId: string,
    transactionId: string,
    signal?: AbortSignal,
  ): Promise<ContainerRebuildTransactionInspection>;
  sampleActivity(instanceId: string, signal?: AbortSignal): Promise<ContainerActivityMetrics>;
  diagnose?(instanceId: string, signal?: AbortSignal): Promise<ContainerFailureDiagnostics>;
  /** 只删除执行工件和 Provider 私有网络。 */
  removeEnvironment?(request: RemoveContainerEnvironmentRequest): Promise<void>;
  /** 只释放已校验的 Workspace 存储挂载。 */
  releaseWorkspaceStorage?(request: ReleaseContainerStorageRequest): Promise<void>;
  /** 期望所有者来自控制面记录，而不是 Docker。 */
  remove(instanceId: string, ownerId: string, signal?: AbortSignal): Promise<void>;
  listImages?(): Promise<Array<{ reference: string; id?: string; size?: string }>>;
  /** 将 tag/digest/id 解析为 Runtime 的不可变镜像 ID。 */
  resolveImage?(reference: string): Promise<string | null>;
  /** 按代码拥有的启动合同校验镜像。 */
  validateImage?(reference: string, runtimeContract: string): Promise<void>;
  /** 对构建镜像执行等同生产的启动冒烟测试。 */
  validateBuiltImage?(reference: string, runtimeContract: string): Promise<void>;
  /** 仅当 tag 仍解析到预期不可变镜像时才删除它。 */
  removeImageIfCurrent?(reference: string, expectedImageId: string): Promise<boolean>;
  pullImage?(reference: string): Promise<void>;
  loadImage?(archivePath: string, reference: string): Promise<void>;
  status?(): Promise<{ runtime: string; available: boolean; version?: string; host?: string; platform?: string; architecture?: string; error?: string }>;
}
