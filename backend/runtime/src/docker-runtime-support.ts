/** Docker 参数、配置、标签与诊断转换；不执行实例生命周期操作。 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  type ContainerActivityMetrics,
  type ContainerCatalogSnapshot,
  type ContainerInstance,
  type ContainerLaunchProfile,
  type ContainerState,
  type ProvisionContainerRequest,
  type StorageBinding,
} from "./container-runtime.js";
import { resourceLabel, type ManagedResourceKind } from "./managed-resource-resolver.js";
import {
  isRuntimeReservedEnvironmentName,
  normalizeMcpAppSandboxOrigin,
  runtimeReservedEnvironmentNames,
} from "./runtime-environment.js";
import { GENERIC_RUNTIME_PROFILE, runtimeProfileFromEnv, type RuntimeProfile } from "./runtime-profile.js";
export const execFileAsync = promisify(execFile);
export const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const APP_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u;
export const RESOURCE_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
// 仅用于未传 profile 的纯函数兼容入口；实例路径始终从 RuntimeProfile 读取。
export const LABEL_PREFIX = GENERIC_RUNTIME_PROFILE.labelPrefix;
export const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
export const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/iu;
export const DOCKER_CONTAINER_HOSTNAME_PATTERN = /^(?=.{1,64}$)[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/iu;
export const MEMORY_PATTERN = /^\d+(?:\.\d+)?[bkmg]?$/iu;
export const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
export const ENVIRONMENT_VALUE_MAX_BYTES = 16 * 1024;
export const ENVIRONMENT_MAX_ENTRIES = 128;
export const ENVIRONMENT_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/u;
export const CONFIG_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*(?:^|\/)\.(?:\/|$))[^\\\0]+$/u;
export const CONFIG_FILES_MAX_BYTES = 256 * 1024;
export const ENVIRONMENT_MAX_BYTES = 64 * 1024;
export const MAX_MEMORY_BYTES = 1024 ** 5;
export const RUNTIME_COMMAND_TIMEOUT_MS = 60_000;
export const RUNTIME_PROBE_TIMEOUT_MS = 10_000;
export const RUNTIME_STOP_TIMEOUT_MS = 45_000;
export const RUNTIME_LONG_COMMAND_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_NETWORK_POOL_CIDR = "10.240.0.0/12";
export const DEFAULT_NETWORK_SUBNET_PREFIX = 28;
export const DEFAULT_RESOURCE_SCHEME = "2";
export const IMAGE_SMOKE_HEALTH_PROBE = (port: number, path: string) =>
  `const deadline=Date.now()+45000;const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));(async()=>{while(Date.now()<deadline){try{const response=await fetch(${JSON.stringify(`http://127.0.0.1:${port}${path}`)},{signal:AbortSignal.timeout(2000)});if(response.ok)process.exit(0)}catch{}await pause(500)}process.exit(1)})()`;
export const REBUILD_ARTIFACT_SUFFIX = /-rebuild-(next|previous|rollback)$/u;
export interface CommandResult {
  stdout: string;
  stderr: string;
}
export interface CommandRunnerOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}
export type CommandRunner = (
  binary: string,
  args: readonly string[],
  options?: CommandRunnerOptions,
) => Promise<CommandResult>;
export const DOCKER_COMMAND_CATEGORIES = new Set([
  "container inspect",
  "container ls",
  "create",
  "exec",
  "image inspect",
  "image rm",
  "images",
  "load",
  "logs",
  "network connect",
  "network create",
  "network disconnect",
  "network inspect",
  "network ls",
  "network rm",
  "pull",
  "rename",
  "rm",
  "run",
  "start",
  "stats",
  "stop",
  "tag",
  "version",
  "volume create",
  "volume inspect",
  "volume ls",
  "ps",
  "volume rm",
]);
export const DOCKER_COMMAND_NAMESPACES = new Set(["container", "image", "network", "volume"]);
export const SAFE_PROCESS_ERROR_CODES = new Set([
  "E2BIG",
  "EACCES",
  "EAGAIN",
  "EMFILE",
  "ENFILE",
  "ENOENT",
  "ENOMEM",
  "ENOTDIR",
  "ETIMEDOUT",
  "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
]);
export const SAFE_DOCKER_FAILURE_REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/No such image/iu, "No such image"],
  [/No such (?:object|container|inspect)/iu, "No such container"],
  [/No such network/iu, "No such network"],
  [/No such volume/iu, "No such volume"],
  [/already exists in network|already connected/iu, "already connected"],
  [/is not connected/iu, "is not connected"],
  [/pool overlaps/iu, "pool overlaps"],
  [/address pool.*overlap/iu, "address pool overlap"],
  [/address pool.*exhaust/iu, "address pool exhausted"],
  [/could not find an available.*address pool/iu, "could not find an available address pool"],
  [/permission denied/iu, "permission denied"],
  [/Cannot connect|connection refused|Is the docker daemon running/iu, "Cannot connect to Docker daemon"],
  [/not found/iu, "resource not found"],
];
export function dockerCommandCategory(args: readonly string[]): string {
  const commandArgs = args[0] === "--context" ? args.slice(2) : args;
  const primary = commandArgs[0] ?? "";
  const candidate = DOCKER_COMMAND_NAMESPACES.has(primary) ? `${primary} ${commandArgs[1] ?? ""}` : primary;
  return DOCKER_COMMAND_CATEGORIES.has(candidate) ? candidate : "command";
}
export function execFileFailureStderr(error: unknown): string {
  if (!error || typeof error !== "object" || !("stderr" in error)) return "";
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === "string") return stderr;
  return Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
}
export function execFileFailureDiagnostics(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const diagnostics: string[] = [];
  const code = (error as { code?: unknown }).code;
  if (typeof code === "number" && Number.isSafeInteger(code)) {
    diagnostics.push(`exit code ${code}`);
  } else if (typeof code === "string" && SAFE_PROCESS_ERROR_CODES.has(code)) {
    diagnostics.push(`system code ${code}`);
  }
  const signal = (error as { signal?: unknown }).signal;
  if (typeof signal === "string" && /^SIG[A-Z0-9]+$/u.test(signal)) {
    diagnostics.push(`signal ${signal}`);
  }
  const stderr = execFileFailureStderr(error);
  const safeReason = SAFE_DOCKER_FAILURE_REASONS.find(([pattern]) => pattern.test(stderr))?.[1];
  if (safeReason) diagnostics.push(safeReason);
  return diagnostics;
}
export function sanitizedDockerCommandError(args: readonly string[], error: unknown): Error {
  const diagnostics = execFileFailureDiagnostics(error);
  const suffix = diagnostics.length ? ` (${diagnostics.join("; ")})` : "";
  const sanitized = new Error(`Docker ${dockerCommandCategory(args)} failed${suffix}`);
  sanitized.name = "DockerCommandError";
  const exitCode =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "number"
      ? (error as { code: number }).code
      : undefined;
  if (exitCode !== undefined) {
    // 仅供内部判断可选 Docker 能力是否存在；不进入对外错误文本。
    Object.defineProperty(sanitized, "dockerExitCode", { value: exitCode, enumerable: false });
  }
  return sanitized;
}
export function isUnsupportedResourceDiscoveryError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "DockerCommandError") return false;
  const exitCode = (error as Error & { dockerExitCode?: unknown }).dockerExitCode;
  if (exitCode === 97) return true;
  // 某些旧版 Docker wrapper 用 125 表示未知子命令/参数；含有 daemon、权限或
  // 连接诊断时必须继续上抛，避免把真实基础设施故障伪装成“没有旧资源”。
  if (exitCode !== 125)
    return /unknown command|unsupported|unrecognized option|invalid option/iu.test(error.message);
  return !/daemon|permission|connect|connection refused|socket|not found/iu.test(error.message);
}
export type DockerContainerCleanupErrorCode =
  "runtime_provision_container_cleanup_failed" | "runtime_rebuild_candidate_container_cleanup_failed";
export class DockerContainerCleanupError extends Error {
  readonly code: DockerContainerCleanupErrorCode;

  constructor(code: DockerContainerCleanupErrorCode) {
    super(code);
    this.name = "DockerContainerCleanupError";
    this.code = code;
  }
}
export interface DockerCliRuntimeConfig {
  binary: "docker";
  runtime?: "docker" | "orbstack";
  dockerContext?: string;
  image: string;
  /** 控制面选择的独立健康探针镜像，业务镜像无需携带解释器。 */
  probeImage?: string;
  networkPrefix: string;
  networkPoolCidr: string;
  networkSubnetPrefix: number;
  portalContainer?: string;
  endpointMode: "loopback" | "network";
  namePrefix: string;
  volumePrefix: string;
  /** App Adapter 声明的运行合同；缺省时仅为旧调用方启用兼容 profile。 */
  profile?: RuntimeProfile;
  /** 由 Adapter/部署注入的固定环境，不来自浏览器或数据库。 */
  runtimeEnvironment?: Readonly<Record<string, string>>;
  /** 通用身份 Provider 地址；具体注入键由 RuntimeProfile 声明。 */
  authProviderBaseUrl?: string;
  allowedOrigins: string;
  mcpAppSandboxOrigin?: string;
  memory: string;
  cpus: string;
  pidsLimit: number;
  targetPlatform: "linux/amd64" | "linux/arm64";
  /** 受管资源命名方案；缺省值保持旧部署兼容。 */
  resourceScheme?: string;
  /** 新配置变更后用于按标签发现旧资源的候选前缀。 */
  legacyNetworkPrefixes?: readonly string[];
  legacyNamePrefixes?: readonly string[];
  legacyVolumePrefixes?: readonly string[];
  /** 允许按旧标签命名空间发现迁移前的受管资源。 */
  legacyLabelPrefixes?: readonly string[];
  /** 允许从 Docker label 扫描无法按名称命中的旧资源。 */
  resourceDiscovery?: boolean;
}
export interface DockerInspect {
  Id: string;
  Created: string;
  Config: {
    Hostname?: string;
    Labels?: Record<string, string>;
  };
  State: {
    Status: string;
    ExitCode?: number;
    OOMKilled?: boolean;
    Health?: { Status?: string };
  };
  HostConfig?: {
    Memory?: number;
    MemorySwap?: number;
    NanoCpus?: number;
    PidsLimit?: number;
  };
  NetworkSettings: {
    Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}
export interface DockerManagedResourceInspect {
  Id?: string;
  Name: string;
  Labels?: Record<string, string>;
  Internal?: boolean;
  Options?: Record<string, string>;
  scheme?: string;
  legacy?: boolean;
  migrationRequired?: boolean;
}
export interface IPv4NetworkPool {
  cidr: string;
  baseAddress: number;
  subnetPrefix: number;
  subnetSize: number;
  subnetCount: number;
}
export type NetworkPolicy = "private" | "egress";
export interface DockerStats {
  CPUPerc?: unknown;
  MemUsage?: unknown;
  NetIO?: unknown;
  PIDs?: unknown;
}
export interface RebuildContainerMetadata {
  id: string;
  predecessorId: string;
  startRequested: boolean;
  sourceCatalogSnapshot?: ContainerCatalogSnapshot;
}
export interface InspectedContainer extends ContainerInstance {
  rebuild?: RebuildContainerMetadata;
  /** Docker inspect 的 hostname；共享 Volume 锁可能记录它而非完整容器 ID。 */
  containerHostname?: string;
  /** Docker 实际名称；旧命名方案下可能不同于当前配置生成的名称。 */
  resourceName?: string;
  resourceScheme?: string;
}
export interface RebuildArtifactNames {
  canonical: string;
  candidate: string;
  previous: string;
  rollback: string;
}
export interface RebuildArtifacts {
  names: RebuildArtifactNames;
  canonical: InspectedContainer | null;
  candidate: InspectedContainer | null;
  previous: InspectedContainer | null;
  rollback: InspectedContainer | null;
  /** 未带 rebuild 元数据的 rollback 占位也必须在 Environment 删除时清理。 */
  rollbackOccupant: InspectedContainer | null;
}
export interface RebuildRecoveryContext {
  instanceId: string;
  ownerId: string;
  restoreRunning: boolean;
  preserveDeferredCandidate: boolean;
  signal: AbortSignal | undefined;
  artifacts: RebuildArtifacts;
  storageBinding: StorageBinding;
}
export interface RebuildPreparation {
  request: ProvisionContainerRequest;
  instanceId: string;
  ownerId: string;
  signal: AbortSignal | undefined;
  existing: InspectedContainer | null;
  launchProfile: ContainerLaunchProfile;
  storageBinding: StorageBinding;
  boundStorage: readonly StorageBinding[] | undefined;
}
export interface StagedRebuildTransaction {
  instanceId: string;
  ownerId: string;
  signal: AbortSignal | undefined;
  names: RebuildArtifactNames;
  wasRunning: boolean;
  rebuild: RebuildContainerMetadata;
  createdCandidateId: string | null;
  storageBinding: StorageBinding;
}
export interface RebuildCutoverProgress {
  previousRenamed: boolean;
  candidateRenamed: boolean;
}
export function requireIdentifier(value: string, field: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${field} must be an opaque server-issued identifier`);
  }
  return value;
}
export function requireAppId(value: string): string {
  if (!APP_ID_PATTERN.test(value)) throw new Error("appId must be a normalized catalog identifier");
  return value;
}
export function requireDockerContainerId(value: string): string {
  if (!DOCKER_CONTAINER_ID_PATTERN.test(value)) {
    throw new Error("Docker returned an invalid managed container ID");
  }
  return value.toLowerCase();
}
export function readDockerContainerHostname(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error("Docker returned an invalid managed container hostname");
  const hostname = value.trim().toLowerCase();
  if (!DOCKER_CONTAINER_HOSTNAME_PATTERN.test(hostname)) {
    throw new Error("Docker returned an invalid managed container hostname");
  }
  return hostname;
}
export function normalizeDockerContainerHostnames(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => readDockerContainerHostname(value))
        .filter((value): value is string => value !== undefined),
    ),
  ];
}
export function mapState(status: string): ContainerState {
  if (status === "running") return "running";
  if (status === "created") return "stopped";
  if (status === "restarting") return "creating";
  if (status === "exited" || status === "dead") return "stopped";
  return "failed";
}
export function parseResourceNameList(stdout: string): string[] {
  const names = new Set<string>();
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    let value = line;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const candidate = record.Name ?? record.Names ?? record.name ?? record.names;
        if (typeof candidate === "string") value = candidate;
      }
    } catch {
      // `--format {{.Name}}` is plain text; malformed JSON is therefore valid.
    }
    // Container list may include an ID before the name when an external Docker
    // wrapper uses a two-column format. Accept only the final safe token.
    const candidate = value.split(/\s+/u).at(-1)?.trim() ?? "";
    if (IDENTIFIER_PATTERN.test(candidate)) names.add(candidate);
  }
  return [...names];
}
export function isMissingDockerResourceError(
  error: unknown,
  kind?: ManagedResourceKind | "container",
): boolean {
  if (!(error instanceof Error)) return false;
  const resource = kind ? `(?:${kind}|object|inspect)` : "(?:container|network|volume|object|inspect)";
  return new RegExp(`No such ${resource}|not found`, "iu").test(error.message);
}
export function isRebuildArtifactName(name: string): boolean {
  return REBUILD_ARTIFACT_SUFFIX.test(name);
}
export function ipv4Address(value: string): number | null {
  const octets = value.split(".");
  if (octets.length !== 4) return null;
  let address = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/u.test(octet)) return null;
    const parsed = Number(octet);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) return null;
    address = address * 256 + parsed;
  }
  return address;
}
export function formatIpv4Address(address: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join(".");
}
export function privateIpv4Range(start: number, end: number): boolean {
  const ranges: ReadonlyArray<readonly [number, number]> = [
    [ipv4Address("10.0.0.0")!, ipv4Address("10.255.255.255")!],
    [ipv4Address("172.16.0.0")!, ipv4Address("172.31.255.255")!],
    [ipv4Address("192.168.0.0")!, ipv4Address("192.168.255.255")!],
  ];
  return ranges.some(([rangeStart, rangeEnd]) => start >= rangeStart && end <= rangeEnd);
}
export function parseNetworkPool(
  cidr: string,
  subnetPrefix: number,
  variablePrefix = "OPENAPP",
): IPv4NetworkPool {
  const [addressText, prefixText, ...extra] = cidr.split("/");
  const address = addressText ? ipv4Address(addressText) : null;
  const poolPrefix = prefixText && /^\d{1,2}$/u.test(prefixText) ? Number(prefixText) : NaN;
  const poolSize =
    Number.isInteger(poolPrefix) && poolPrefix >= 8 && poolPrefix <= 28 ? 2 ** (32 - poolPrefix) : 0;
  const baseAddress = address === null || poolSize === 0 ? -1 : Math.floor(address / poolSize) * poolSize;
  const endAddress = baseAddress < 0 ? -1 : baseAddress + poolSize - 1;
  if (
    extra.length ||
    address === null ||
    baseAddress !== address ||
    !privateIpv4Range(baseAddress, endAddress)
  ) {
    throw new Error(`${variablePrefix}_NETWORK_POOL_CIDR must be an aligned private IPv4 CIDR`);
  }
  if (!Number.isInteger(subnetPrefix) || subnetPrefix <= poolPrefix || subnetPrefix > 29) {
    throw new Error(
      `${variablePrefix}_NETWORK_SUBNET_PREFIX must be an integer between ${poolPrefix + 1} and 29`,
    );
  }
  return {
    cidr: `${formatIpv4Address(baseAddress)}/${poolPrefix}`,
    baseAddress,
    subnetPrefix,
    subnetSize: 2 ** (32 - subnetPrefix),
    subnetCount: 2 ** (subnetPrefix - poolPrefix),
  };
}
export function stableHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
export interface DockerCliRuntimeConfigOptions {
  /** 仅用于迁移兼容；调用方必须同时显式提供 profile。 */
  readonly compatibilityMode?: boolean;
  /** 组合根选择的运行合同；未提供时使用通用 profile。 */
  readonly profile?: RuntimeProfile;
}
export function dockerCliRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: DockerCliRuntimeConfigOptions = {},
): DockerCliRuntimeConfig {
  if (options.compatibilityMode === true && options.profile === undefined) {
    throw new Error("runtime compatibility mode requires an explicit profile");
  }
  const profile = options.profile ?? runtimeProfileFromEnv(env);
  const variablePrefix = profile.environmentPrefix ?? "OPENAPP";
  const profileValue = (suffix: string, ...aliases: readonly (string | undefined)[]): string | undefined =>
    firstConfigured(
      env[`OPENAPP_${suffix}`],
      ...(variablePrefix === "OPENAPP" ? [] : [env[`${variablePrefix}_${suffix}`]]),
      ...aliases,
    );
  const profileImage =
    variablePrefix === "OPENAPP" && options.compatibilityMode !== true
      ? undefined
      : profileValue("CONTAINER_IMAGE");
  const endpointMode = env.CONTAINER_RUNTIME_ENDPOINT_MODE ?? "loopback";
  if (endpointMode !== "loopback" && endpointMode !== "network") {
    throw new Error("CONTAINER_RUNTIME_ENDPOINT_MODE must be loopback or network");
  }

  const pidsLimit = Number(firstConfigured(profileValue("CONTAINER_PIDS_LIMIT")) ?? "512");
  if (!Number.isSafeInteger(pidsLimit) || pidsLimit < 32) {
    throw new Error(`${variablePrefix}_CONTAINER_PIDS_LIMIT must be an integer >= 32`);
  }

  const runtime = env.CONTAINER_RUNTIME ?? "docker";
  if (runtime !== "docker" && runtime !== "orbstack") {
    throw new Error("CONTAINER_RUNTIME must be docker or orbstack");
  }
  const dockerContext = env.DOCKER_CONTEXT;
  if (dockerContext && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dockerContext)) {
    throw new Error("DOCKER_CONTEXT contains unsupported characters");
  }
  const networkPrefix =
    firstConfigured(profileValue("NETWORK_NAME_PREFIX")) ?? profile.defaultNetworkPrefix ?? "openapp-net-";
  const networkPoolCidr = firstConfigured(profileValue("NETWORK_POOL_CIDR")) ?? DEFAULT_NETWORK_POOL_CIDR;
  const networkSubnetPrefix = Number(
    firstConfigured(profileValue("NETWORK_SUBNET_PREFIX")) ?? DEFAULT_NETWORK_SUBNET_PREFIX,
  );
  const networkPool = parseNetworkPool(networkPoolCidr, networkSubnetPrefix, variablePrefix);
  const portalContainer = profileValue("PORTAL_CONTAINER") || env.HOSTNAME?.trim();
  const namePrefix =
    firstConfigured(profileValue("CONTAINER_NAME_PREFIX")) ??
    profile.defaultContainerPrefix ??
    "openapp-user-";
  const volumePrefix =
    firstConfigured(profileValue("VOLUME_NAME_PREFIX")) ?? profile.defaultVolumePrefix ?? "openapp-data-";
  if (!RESOURCE_PREFIX_PATTERN.test(networkPrefix)) {
    throw new Error(`${variablePrefix}_NETWORK_NAME_PREFIX contains unsupported characters`);
  }
  if (!RESOURCE_PREFIX_PATTERN.test(namePrefix)) {
    throw new Error(`${variablePrefix}_CONTAINER_NAME_PREFIX contains unsupported characters`);
  }
  if (!RESOURCE_PREFIX_PATTERN.test(volumePrefix)) {
    throw new Error(`${variablePrefix}_VOLUME_NAME_PREFIX contains unsupported characters`);
  }
  if (endpointMode === "network" && (!portalContainer || !IDENTIFIER_PATTERN.test(portalContainer))) {
    throw new Error(`${variablePrefix}_PORTAL_CONTAINER is required in network endpoint mode`);
  }
  const targetPlatform = env.TARGET_PLATFORM ?? "linux/amd64";
  if (targetPlatform !== "linux/amd64" && targetPlatform !== "linux/arm64") {
    throw new Error("TARGET_PLATFORM must be linux/amd64 or linux/arm64");
  }
  const mcpAppSandboxOrigin = normalizeMcpAppSandboxOrigin(env.MCP_APP_SANDBOX_ORIGIN);

  const resourceScheme = firstConfigured(profileValue("RESOURCE_SCHEME_VERSION")) ?? DEFAULT_RESOURCE_SCHEME;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(resourceScheme)) {
    throw new Error(`${variablePrefix}_RESOURCE_SCHEME_VERSION contains unsupported characters`);
  }
  const legacyNetworkPrefixes = parseResourcePrefixes(
    profileValue("LEGACY_NETWORK_NAME_PREFIXES"),
    networkPrefix,
    profile.legacyResourcePrefixes?.network ?? [],
  );
  const legacyNamePrefixes = parseResourcePrefixes(
    profileValue("LEGACY_CONTAINER_NAME_PREFIXES"),
    namePrefix,
    profile.legacyResourcePrefixes?.container ?? [],
  );
  const legacyVolumePrefixes = parseResourcePrefixes(
    profileValue("LEGACY_VOLUME_NAME_PREFIXES"),
    volumePrefix,
    profile.legacyResourcePrefixes?.volume ?? [],
  );
  const legacyLabelPrefixes = parseResourcePrefixes(
    profileValue("LEGACY_LABEL_PREFIXES"),
    profile.labelPrefix,
    profile.legacyResourcePrefixes?.label ?? [],
  );
  const configuredAuthProviderBaseUrl = firstConfigured(
    env.OPENAPP_AUTH_PROVIDER_BASE_URL,
    env.AUTH_PROVIDER_BASE_URL,
    ...(profile.providerEnvironment?.authProviderKey
      ? [env[profile.providerEnvironment.authProviderKey]]
      : []),
  );
  const authProviderBaseUrl =
    configuredAuthProviderBaseUrl ?? profile.providerEnvironment?.defaultAuthProviderBaseUrl ?? "";

  return {
    binary: "docker",
    runtime,
    probeImage: env.OPENAPP_RUNTIME_PROBE_IMAGE?.trim() || "node:24-bookworm-slim",
    ...(dockerContext ? { dockerContext } : {}),
    image:
      firstConfigured(
        env.OPENAPP_RUNTIME_IMAGE,
        // 旧部署曾把镜像写入 OPENAPP_CONTAINER_IMAGE；该别名只在显式
        // compatibility profile 中读取，避免通用 App 被残留变量劫持。
        ...(options.compatibilityMode === true ? [env.OPENAPP_CONTAINER_IMAGE] : []),
        profileImage,
      ) ??
      profile.defaultImage ??
      "openapp-runtime:0.1.0",
    profile,
    runtimeEnvironment: readRuntimeEnvironment(env, profile),
    networkPrefix,
    networkPoolCidr: networkPool.cidr,
    networkSubnetPrefix: networkPool.subnetPrefix,
    ...(portalContainer ? { portalContainer } : {}),
    endpointMode,
    namePrefix,
    volumePrefix,
    ...(authProviderBaseUrl ? { authProviderBaseUrl } : {}),
    allowedOrigins:
      firstConfigured(
        env.OPENAPP_RUNTIME_ALLOWED_ORIGINS,
        profile.providerEnvironment?.allowedOriginsKey
          ? env[profile.providerEnvironment.allowedOriginsKey]
          : undefined,
      ) ?? "http://localhost",
    ...(mcpAppSandboxOrigin ? { mcpAppSandboxOrigin } : {}),
    memory: firstConfigured(env.OPENAPP_CONTAINER_MEMORY, profileValue("CONTAINER_MEMORY")) ?? "4g",
    cpus: firstConfigured(env.OPENAPP_CONTAINER_CPUS, profileValue("CONTAINER_CPUS")) ?? "2",
    pidsLimit,
    targetPlatform,
    resourceScheme,
    legacyNetworkPrefixes,
    legacyNamePrefixes,
    legacyVolumePrefixes,
    legacyLabelPrefixes,
    resourceDiscovery: parseBoolean(profileValue("RESOURCE_DISCOVERY"), true),
  };
}
export function firstConfigured(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim();
}
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`${value} must be true or false`);
}
export function readRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  profile: RuntimeProfile,
): Readonly<Record<string, string>> {
  const configured = env.OPENAPP_RUNTIME_ENVIRONMENT_JSON?.trim();
  const configuredValues: Record<string, string> = {};
  if (configured) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(configured);
    } catch {
      throw new Error("OPENAPP_RUNTIME_ENVIRONMENT_JSON must be a JSON object");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("OPENAPP_RUNTIME_ENVIRONMENT_JSON must be a JSON object");
    }
    Object.assign(
      configuredValues,
      validateRuntimeEnvironmentEntries(parsed, profile, {
        source: "OPENAPP_RUNTIME_ENVIRONMENT_JSON",
        rejectReserved: true,
      }),
    );
  }
  return Object.freeze({
    ...configuredValues,
    ...providerRuntimeEnvironment(env, profile),
  });
}
export function providerRuntimeEnvironment(
  env: NodeJS.ProcessEnv,
  profile: RuntimeProfile,
): Readonly<Record<string, string>> {
  const providerEnvironment = profile.providerEnvironment;
  if (!providerEnvironment) return {};
  const result: Record<string, string> = {};
  const authProviderKey = providerEnvironment.authProviderKey;
  const allowedOriginsKey = providerEnvironment.allowedOriginsKey;
  const mcpKey = providerEnvironment.mcpAppSandboxOriginKey;
  const authProviderBaseUrl =
    firstConfigured(
      env.OPENAPP_AUTH_PROVIDER_BASE_URL,
      env.AUTH_PROVIDER_BASE_URL,
      ...(authProviderKey ? [env[authProviderKey]] : []),
    ) ?? providerEnvironment.defaultAuthProviderBaseUrl;
  if (authProviderKey && authProviderBaseUrl) result[authProviderKey] = authProviderBaseUrl;
  const allowedOrigins =
    firstConfigured(
      env.OPENAPP_RUNTIME_ALLOWED_ORIGINS,
      ...(allowedOriginsKey ? [env[allowedOriginsKey]] : []),
    ) ?? "http://localhost";
  if (allowedOriginsKey) result[allowedOriginsKey] = allowedOrigins;
  if (mcpKey && env.MCP_APP_SANDBOX_ORIGIN) result[mcpKey] = env.MCP_APP_SANDBOX_ORIGIN;
  return result;
}
export function validateRuntimeEnvironmentEntries(
  value: unknown,
  profile: RuntimeProfile,
  options: { source: string; rejectReserved: boolean },
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${options.source} must be a JSON object`);
  }
  const entries = Object.entries(value);
  if (entries.length > ENVIRONMENT_MAX_ENTRIES) {
    throw new Error(`${options.source} is too large`);
  }
  const reserved = runtimeReservedEnvironmentNames(profile);
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const [key, item] of entries) {
    if (!ENVIRONMENT_NAME_PATTERN.test(key)) {
      throw new Error(`${options.source} key is invalid: ${key}`);
    }
    if (options.rejectReserved && isRuntimeReservedEnvironmentName(key, { additionalReserved: reserved })) {
      throw new Error(`${options.source} key is reserved: ${key}`);
    }
    if (typeof item !== "string" || ENVIRONMENT_CONTROL_PATTERN.test(item)) {
      throw new Error(`${options.source} value is invalid: ${key}`);
    }
    const valueBytes = Buffer.byteLength(item);
    if (valueBytes > ENVIRONMENT_VALUE_MAX_BYTES) {
      throw new Error(`${options.source} value is too large: ${key}`);
    }
    totalBytes += Buffer.byteLength(key) + valueBytes;
    if (totalBytes > ENVIRONMENT_MAX_BYTES) {
      throw new Error(`${options.source} is too large`);
    }
    result[key] = item;
  }
  return result;
}
export function runtimeEnvironmentForConfig(
  config: DockerCliRuntimeConfig,
  profile: RuntimeProfile,
): Readonly<Record<string, string>> {
  const providerEnvironment = profile.providerEnvironment;
  if (!providerEnvironment) return {};
  const result: Record<string, string> = {};
  if (providerEnvironment.authProviderKey) {
    const value = config.authProviderBaseUrl;
    if (value) result[providerEnvironment.authProviderKey] = value;
  }
  if (providerEnvironment.allowedOriginsKey)
    result[providerEnvironment.allowedOriginsKey] = config.allowedOrigins;
  if (providerEnvironment.mcpAppSandboxOriginKey && config.mcpAppSandboxOrigin) {
    result[providerEnvironment.mcpAppSandboxOriginKey] = config.mcpAppSandboxOrigin;
  }
  return result;
}
/**
 * Keep deployment/provider values separate from caller-provided values. The
 * environment loader returns both in one config object for backwards
 * compatibility, so the constructor must verify that a reserved Provider key
 * is either the exact trusted value or rejected as an override.
 */
export function resolveRuntimeEnvironment(
  config: DockerCliRuntimeConfig,
  profile: RuntimeProfile,
): Readonly<Record<string, string>> {
  const providerValues = runtimeEnvironmentForConfig(config, profile);
  if (config.runtimeEnvironment === undefined) {
    return Object.freeze(
      validateRuntimeEnvironmentEntries(providerValues, profile, {
        source: "runtime environment",
        rejectReserved: false,
      }),
    );
  }

  const supplied = validateRuntimeEnvironmentEntries(config.runtimeEnvironment, profile, {
    source: "runtime environment",
    rejectReserved: false,
  });
  const callerValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (Object.hasOwn(providerValues, key)) {
      if (value !== providerValues[key]) {
        throw new Error(`runtime environment key is reserved: ${key}`);
      }
      continue;
    }
    callerValues[key] = value;
  }
  const validatedCallerValues = validateRuntimeEnvironmentEntries(callerValues, profile, {
    source: "runtime environment",
    rejectReserved: true,
  });
  const validatedProviderValues = validateRuntimeEnvironmentEntries(providerValues, profile, {
    source: "runtime environment",
    rejectReserved: false,
  });
  return Object.freeze({ ...validatedCallerValues, ...validatedProviderValues });
}
export function parseResourcePrefixes(
  configured: string | undefined,
  current: string,
  defaults: readonly string[],
): string[] {
  const values =
    configured === undefined
      ? [...defaults]
      : configured
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean);
  const unique = new Set<string>();
  for (const prefix of [current, ...values]) {
    if (!RESOURCE_PREFIX_PATTERN.test(prefix)) {
      throw new Error("resource name prefix contains unsupported characters");
    }
    unique.add(prefix);
  }
  return [...unique];
}
export function rebuildMetadata(
  labels: Record<string, string>,
  labelPrefixes: readonly string[] = [LABEL_PREFIX],
): { rebuild?: RebuildContainerMetadata } {
  const id = resourceLabel(labels, "rebuild-id", labelPrefixes);
  const predecessorId = resourceLabel(labels, "rebuild-predecessor-id", labelPrefixes);
  const role = resourceLabel(labels, "rebuild-role", labelPrefixes);
  const startRequested = resourceLabel(labels, "rebuild-start-requested", labelPrefixes);
  const values = [id, predecessorId, role, startRequested];
  if (values.every((value) => value === undefined)) return {};
  if (
    !id ||
    !predecessorId ||
    role !== "candidate" ||
    (startRequested !== "true" && startRequested !== "false")
  ) {
    throw new Error("managed rebuild metadata is incomplete");
  }
  const sourceCatalogSnapshot = catalogSnapshotMetadata(
    labels,
    "rebuild-source-",
    labelPrefixes,
  ).catalogSnapshot;
  return {
    rebuild: {
      id: requireIdentifier(id, "rebuildId"),
      predecessorId: requireDockerContainerId(predecessorId),
      startRequested: startRequested === "true",
      ...(sourceCatalogSnapshot ? { sourceCatalogSnapshot } : {}),
    },
  };
}
export function catalogSnapshotLabelArgs(
  snapshot: ContainerCatalogSnapshot,
  prefix = "",
  labelPrefix = LABEL_PREFIX,
): string[] {
  const appId = requireAppId(snapshot.appId);
  if (!IMAGE_PATTERN.test(snapshot.imageReference))
    throw new Error("catalog snapshot image reference is invalid");
  const labels = [
    "--label",
    `${labelPrefix}.${prefix}catalog-snapshot=true`,
    "--label",
    `${labelPrefix}.${prefix}app-id=${appId}`,
    "--label",
    `${labelPrefix}.${prefix}image-reference=${snapshot.imageReference}`,
  ];
  if (snapshot.appVersionId) {
    labels.push(
      "--label",
      `${labelPrefix}.${prefix}app-version-id=${requireIdentifier(snapshot.appVersionId, "appVersionId")}`,
    );
  }
  if (snapshot.imageArtifactId) {
    labels.push(
      "--label",
      `${labelPrefix}.${prefix}image-artifact-id=${requireIdentifier(snapshot.imageArtifactId, "imageArtifactId")}`,
    );
  }
  return labels;
}
export function catalogSnapshotMetadata(
  labels: Record<string, string>,
  prefix = "",
  labelPrefixes: readonly string[] = [LABEL_PREFIX],
): { catalogSnapshot?: ContainerCatalogSnapshot } {
  const marker = resourceLabel(labels, `${prefix}catalog-snapshot`, labelPrefixes);
  if (marker === undefined) return {};
  if (marker !== "true") throw new Error("managed container catalog snapshot marker is invalid");
  const appId = resourceLabel(labels, `${prefix}app-id`, labelPrefixes);
  const imageReference = resourceLabel(labels, `${prefix}image-reference`, labelPrefixes);
  if (!appId || !imageReference || !IMAGE_PATTERN.test(imageReference)) {
    throw new Error("managed container catalog snapshot is incomplete");
  }
  const appVersionId = resourceLabel(labels, `${prefix}app-version-id`, labelPrefixes);
  const imageArtifactId = resourceLabel(labels, `${prefix}image-artifact-id`, labelPrefixes);
  return {
    catalogSnapshot: {
      appId: requireAppId(appId),
      appVersionId: appVersionId ? requireIdentifier(appVersionId, "appVersionId") : null,
      imageArtifactId: imageArtifactId ? requireIdentifier(imageArtifactId, "imageArtifactId") : null,
      imageReference,
    },
  };
}
export function validMemory(value: string): boolean {
  if (!MEMORY_PATTERN.test(value)) return false;
  const match = value.match(/^(\d+(?:\.\d+)?)([bkmg]?)$/iu);
  if (!match) return false;
  const amount = Number(match[1]);
  const multiplier = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  const bytes = amount * multiplier;
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_MEMORY_BYTES;
}
export function parseDockerStats(stats: DockerStats): ContainerActivityMetrics {
  const network = splitMetric(stats.NetIO, "NetIO");
  const memory = splitMetric(stats.MemUsage, "MemUsage")[0];
  const cpuPercent = parsePercentage(stats.CPUPerc, "CPUPerc");
  const pids = typeof stats.PIDs === "string" ? Number(stats.PIDs.trim()) : Number.NaN;
  if (!Number.isSafeInteger(pids) || pids < 0) throw new Error("unexpected docker stats PIDs");
  return {
    networkRxBytes: parseBytes(network[0], "NetIO received"),
    networkTxBytes: parseBytes(network[1], "NetIO transmitted"),
    cpuPercent,
    memoryWorkingSetBytes: parseBytes(memory, "MemUsage"),
    pids,
  };
}
export function splitMetric(value: unknown, field: string): [string, string] {
  if (typeof value !== "string") throw new Error(`unexpected docker stats ${field}`);
  const parts = value.split("/").map((part) => part.trim());
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error(`unexpected docker stats ${field}`);
  return [parts[0], parts[1]];
}
export function parsePercentage(value: unknown, field: string): number {
  if (typeof value !== "string" || !value.trim().endsWith("%")) {
    throw new Error(`unexpected docker stats ${field}`);
  }
  const parsed = Number(value.trim().slice(0, -1));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`unexpected docker stats ${field}`);
  return parsed;
}
export function parseBytes(value: string, field: string): number {
  const match = value.match(/^(\d+(?:\.\d+)?)\s*([kmgtpe]?i?b)$/iu);
  if (!match) throw new Error(`unexpected docker stats ${field}`);
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const prefixes = ["", "k", "m", "g", "t", "p", "e"];
  const prefixIndex = prefixes.indexOf(unit.replace(/i?b$/u, ""));
  const base = unit.includes("i") ? 1024 : 1000;
  const bytes = amount * base ** prefixIndex;
  if (prefixIndex < 0 || !Number.isFinite(bytes) || bytes < 0 || !Number.isSafeInteger(Math.round(bytes))) {
    throw new Error(`unexpected docker stats ${field}`);
  }
  return Math.round(bytes);
}
