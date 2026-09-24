import {
  DockerCliRuntime,
  dockerCliRuntimeConfigFromEnv,
  type ContainerInstance,
  type ContainerActivityMetrics,
  type ContainerLaunchProfile,
  type ContainerRuntime,
  type ExecutionEnvironment,
  type ExecutionEnvironmentDescriptor,
  ContainerRuntimeExecutionEnvironment,
  GENERIC_EXECUTION_CONTRACT,
  type RuntimeProfile,
} from "@openapp/container-runtime";

export type {
  ContainerActivityMetrics,
  ContainerCatalogSnapshot,
  ContainerFailureDiagnostics,
  ContainerInstance,
  ContainerLaunchProfile,
  ContainerRuntime,
  ExecutionEnvironment,
  ExecutionEnvironmentDescriptor,
  DeferredCandidateAcceptance,
  ReleaseContainerStorageRequest,
  RemoveContainerEnvironmentRequest,
  ResolveStorageBindingRequest,
  StorageBinding,
} from "@openapp/container-runtime";
export {
  ContainerArtifactValidationError,
  ContainerRebuildRollbackError,
  ManagedResourceResolutionError,
  NO_RUNTIME_CONTRACT,
  GENERIC_RUNTIME_CONTRACT,
} from "@openapp/container-runtime";

export { ContainerRuntimeExecutionEnvironment, GENERIC_EXECUTION_CONTRACT } from "@openapp/container-runtime";
export {
  GENERIC_RUNTIME_PROFILE,
  runtimeProfileFromEnv,
  validateRuntimeProfile,
} from "@openapp/container-runtime";
export type { RuntimeProfile } from "@openapp/container-runtime";

/**
 * 运行时只由控制面创建，所有镜像、Volume、网络和资源限制都在 Provider 内固定。
 * OrbStack 使用 Docker-compatible CLI/context，因此不需要给业务层增加平台分支。
 */
export interface ContainerRuntimeOptions {
  /** 生产组合根显式传 false，旧直接调用可省略以保留历史变量兼容。 */
  readonly compatibilityMode?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  /** Adapter-selected workload profile; absent only for legacy direct callers. */
  readonly profile?: RuntimeProfile;
}

export function createContainerRuntime(options: ContainerRuntimeOptions = {}): ContainerRuntime {
  return new DockerCliRuntime(dockerCliRuntimeConfigFromEnv(
    options.environment ?? process.env,
    { compatibilityMode: options.compatibilityMode, profile: options.profile },
  ));
}

/**
 * 组合根使用的 Provider 中性执行合同；当前仍由兼容 Docker Runtime 提供实现。
 */
export function createExecutionEnvironment(
  runtime: ContainerRuntime = createContainerRuntime(),
  descriptor: ExecutionEnvironmentDescriptor = {
    providerId: "docker",
    kind: "container",
    contract: GENERIC_EXECUTION_CONTRACT,
    accessMode: "direct_http",
  },
): ExecutionEnvironment {
  return new ContainerRuntimeExecutionEnvironment(runtime, descriptor);
}
