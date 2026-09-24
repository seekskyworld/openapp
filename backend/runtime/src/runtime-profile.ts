/**
 * Provider 无关的工作负载运行合同。Core 只消费这些稳定字段，具体镜像、
 * 启动脚本和应用环境由 App Adapter 在部署时选择。
 */
export interface RuntimeProfile {
  readonly id: string;
  readonly contract: string;
  /** 部署配置的环境变量命名空间；省略时使用 OPENAPP。 */
  readonly environmentPrefix?: string;
  /** profile 自己的默认镜像和 Docker 资源命名；Core 不按 App id 推断。 */
  readonly defaultImage?: string;
  readonly defaultNetworkPrefix?: string;
  readonly defaultContainerPrefix?: string;
  readonly defaultVolumePrefix?: string;
  readonly labelPrefix: string;
  readonly storageClass: string;
  readonly storageMountPath: string;
  readonly containerPort: number;
  readonly containerUser: string;
  readonly entrypoint: string;
  readonly command: readonly string[];
  /** 可选的恢复命令；首项为镜像内可执行文件，不经过 shell。 */
  readonly recoveryCommand?: readonly string[];
  readonly configEnvironmentKey: string;
  readonly lockRecoveryEnvironment?: {
    readonly containers: string;
    readonly hosts: string;
    readonly recoveryId: string;
  };
  readonly reservedEnvironment: readonly string[];
  readonly healthPath: string;
  /** 由 Adapter 声明的可选工作负载变量；没有声明时 Runtime 不注入产品变量。 */
  readonly providerEnvironment?: {
    readonly authProviderKey?: string;
    readonly allowedOriginsKey?: string;
    readonly mcpAppSandboxOriginKey?: string;
    readonly defaultAuthProviderBaseUrl?: string;
  };
  /** 迁移旧部署时允许按标签/名称发现的别名，必须由 Adapter 显式声明。 */
  readonly legacyResourcePrefixes?: {
    readonly network?: readonly string[];
    readonly container?: readonly string[];
    readonly volume?: readonly string[];
    readonly label?: readonly string[];
  };
}

/** 新 App 的默认合同不携带任何产品名称或业务路径。 */
export const GENERIC_RUNTIME_PROFILE: RuntimeProfile = Object.freeze({
  id: "generic",
  contract: "generic-v1",
  environmentPrefix: "OPENAPP",
  defaultImage: "openapp-runtime:0.1.0",
  defaultNetworkPrefix: "openapp-net-",
  defaultContainerPrefix: "openapp-user-",
  defaultVolumePrefix: "openapp-data-",
  labelPrefix: "io.openapp.portal",
  storageClass: "workspace-data",
  storageMountPath: "/var/lib/openapp",
  containerPort: 37371,
  containerUser: "openapp",
  entrypoint: "/opt/openapp/start.sh",
  command: Object.freeze(["web", "--host", "0.0.0.0", "--port", "37371"]),
  configEnvironmentKey: "OPENAPP_CONFIG_FILES_JSON",
  reservedEnvironment: Object.freeze([
    "OPENAPP_CONFIG_FILES_JSON",
  ]),
  healthPath: "/api/health",
  providerEnvironment: Object.freeze({
    mcpAppSandboxOriginKey: "OPENAPP_MCP_APP_SANDBOX_ORIGIN",
  }),
});

const ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;
const LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const PATH_PATTERN = /^\/(?:[^\0]|\\.)+$/u;
const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const ENVIRONMENT_PREFIX_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/u;

/** 从部署环境读取并校验运行合同；不接受请求或数据库中的执行字段。 */
export function runtimeProfileFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeProfile {
  if (env.OPENAPP_RUNTIME_RECOVERY_SCRIPT) {
    throw new Error("use OPENAPP_RUNTIME_RECOVERY_COMMAND with an explicit executable instead of OPENAPP_RUNTIME_RECOVERY_SCRIPT");
  }
  if (!env.OPENAPP_RUNTIME_RECOVERY_COMMAND && [env.OPENAPP_RUNTIME_LOCK_CONTAINERS_ENV,
    env.OPENAPP_RUNTIME_LOCK_HOSTS_ENV, env.OPENAPP_RUNTIME_LOCK_ID_ENV].some((value) => value !== undefined)) {
    throw new Error("runtime profile recovery command and environment must be declared together");
  }
  const profile = {
    ...GENERIC_RUNTIME_PROFILE,
    id: env.OPENAPP_RUNTIME_PROFILE_ID?.trim() || GENERIC_RUNTIME_PROFILE.id,
    contract: env.OPENAPP_RUNTIME_CONTRACT?.trim() || GENERIC_RUNTIME_PROFILE.contract,
    labelPrefix: env.OPENAPP_RUNTIME_LABEL_PREFIX?.trim() || GENERIC_RUNTIME_PROFILE.labelPrefix,
    storageClass: env.OPENAPP_RUNTIME_STORAGE_CLASS?.trim() || GENERIC_RUNTIME_PROFILE.storageClass,
    storageMountPath: env.OPENAPP_RUNTIME_STORAGE_MOUNT_PATH?.trim() || GENERIC_RUNTIME_PROFILE.storageMountPath,
    containerPort: parsePort(env.OPENAPP_RUNTIME_CONTAINER_PORT, GENERIC_RUNTIME_PROFILE.containerPort),
    containerUser: env.OPENAPP_RUNTIME_CONTAINER_USER?.trim() || GENERIC_RUNTIME_PROFILE.containerUser,
    entrypoint: env.OPENAPP_RUNTIME_ENTRYPOINT?.trim() || GENERIC_RUNTIME_PROFILE.entrypoint,
    command: parseCommand(env.OPENAPP_RUNTIME_COMMAND, GENERIC_RUNTIME_PROFILE.command),
    ...(env.OPENAPP_RUNTIME_RECOVERY_COMMAND ? {
      recoveryCommand: parseCommand(env.OPENAPP_RUNTIME_RECOVERY_COMMAND, []),
      lockRecoveryEnvironment: {
        containers: env.OPENAPP_RUNTIME_LOCK_CONTAINERS_ENV?.trim() ?? "",
        hosts: env.OPENAPP_RUNTIME_LOCK_HOSTS_ENV?.trim() ?? "",
        recoveryId: env.OPENAPP_RUNTIME_LOCK_ID_ENV?.trim() ?? "",
      },
    } : {}),
    configEnvironmentKey: env.OPENAPP_RUNTIME_CONFIG_ENV?.trim() || GENERIC_RUNTIME_PROFILE.configEnvironmentKey,
    reservedEnvironment: parseReservedEnvironment(env.OPENAPP_RUNTIME_RESERVED_ENV, GENERIC_RUNTIME_PROFILE.reservedEnvironment),
    healthPath: env.OPENAPP_RUNTIME_HEALTH_PATH?.trim() || GENERIC_RUNTIME_PROFILE.healthPath,
  } satisfies RuntimeProfile;
  validateRuntimeProfile(profile);
  return Object.freeze({
    ...profile,
    command: Object.freeze([...profile.command]),
    ...(profile.recoveryCommand ? { recoveryCommand: Object.freeze([...profile.recoveryCommand]) } : {}),
    ...(profile.lockRecoveryEnvironment ? { lockRecoveryEnvironment: Object.freeze({ ...profile.lockRecoveryEnvironment }) } : {}),
    reservedEnvironment: Object.freeze([...profile.reservedEnvironment]),
  });
}

export function validateRuntimeProfile(profile: RuntimeProfile): void {
  if ("recoveryScript" in profile) throw new Error("runtime profile must declare recoveryCommand instead of recoveryScript");
  if (!ID_PATTERN.test(profile.id) || !ID_PATTERN.test(profile.contract)) throw new Error("runtime profile id or contract is invalid");
  if (profile.environmentPrefix !== undefined && !ENVIRONMENT_PREFIX_PATTERN.test(profile.environmentPrefix)) {
    throw new Error("runtime profile environment prefix is invalid");
  }
  for (const prefix of [profile.defaultNetworkPrefix, profile.defaultContainerPrefix, profile.defaultVolumePrefix]) {
    if (prefix !== undefined && (!prefix || !LABEL_PATTERN.test(prefix))) {
      throw new Error("runtime profile resource prefix is invalid");
    }
  }
  if (profile.defaultImage !== undefined && (!profile.defaultImage || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u.test(profile.defaultImage))) {
    throw new Error("runtime profile image is invalid");
  }
  if (!LABEL_PATTERN.test(profile.labelPrefix)) throw new Error("runtime profile label prefix is invalid");
  if (!profile.storageClass || !LABEL_PATTERN.test(profile.storageClass)) throw new Error("runtime profile storage class is invalid");
  for (const path of [profile.storageMountPath, profile.entrypoint, profile.healthPath]) {
    if (!PATH_PATTERN.test(path) || path.includes("..")) throw new Error("runtime profile path is invalid");
  }
  if (!Number.isSafeInteger(profile.containerPort) || profile.containerPort < 1 || profile.containerPort > 65_535) {
    throw new Error("runtime profile container port is invalid");
  }
  if (!/^[a-z_][a-z0-9_-]{0,63}$/iu.test(profile.containerUser)) throw new Error("runtime profile container user is invalid");
  if (profile.command.length === 0 || profile.command.some((part) => typeof part !== "string" || !part || part.includes("\0"))) {
    throw new Error("runtime profile command is invalid");
  }
  if ((profile.recoveryCommand === undefined) !== (profile.lockRecoveryEnvironment === undefined)) {
    throw new Error("runtime profile recovery command and environment must be declared together");
  }
  if (profile.recoveryCommand && (profile.recoveryCommand.length === 0
    || profile.recoveryCommand.some((part) => typeof part !== "string" || !part || part.includes("\0")))) {
    throw new Error("runtime profile recovery command is invalid");
  }
  if (!ENV_NAME_PATTERN.test(profile.configEnvironmentKey)
    || (profile.lockRecoveryEnvironment && Object.values(profile.lockRecoveryEnvironment).some((name) => !ENV_NAME_PATTERN.test(name)))
    || profile.reservedEnvironment.some((name) => !ENV_NAME_PATTERN.test(name))) {
    throw new Error("runtime profile environment key is invalid");
  }
  if (profile.providerEnvironment) {
    for (const key of [
      profile.providerEnvironment.authProviderKey,
      profile.providerEnvironment.allowedOriginsKey,
      profile.providerEnvironment.mcpAppSandboxOriginKey,
    ]) {
      if (key !== undefined && !ENV_NAME_PATTERN.test(key)) throw new Error("runtime profile provider environment key is invalid");
    }
    if (profile.providerEnvironment.defaultAuthProviderBaseUrl !== undefined) {
      try { new URL(profile.providerEnvironment.defaultAuthProviderBaseUrl); }
      catch { throw new Error("runtime profile provider environment URL is invalid"); }
    }
  }
  if (profile.legacyResourcePrefixes) {
    for (const values of Object.values(profile.legacyResourcePrefixes)) {
      if (values?.some((value) => !LABEL_PATTERN.test(value))) throw new Error("runtime profile legacy resource prefix is invalid");
    }
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("OPENAPP_RUNTIME_CONTAINER_PORT must be an integer");
  return parsed;
}

function parseCommand(value: string | undefined, fallback: readonly string[]): readonly string[] {
  if (!value?.trim()) return fallback;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string")) throw new Error();
    return parsed as string[];
  } catch {
    throw new Error("OPENAPP_RUNTIME_COMMAND must be a JSON string array");
  }
}

function parseReservedEnvironment(value: string | undefined, fallback: readonly string[]): readonly string[] {
  if (!value?.trim()) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
