/**
 * OpenApp 与外部应用适配器之间的最小公开合同。
 * 这里只放可序列化描述和窄接口，不依赖 Portal、数据库或 Provider 的内部实现。
 */

export const OPENAPP_ADAPTER_API_VERSION = "v2" as const;
import { validateBuildPackageRequirements } from "./package-requirements.js";
export { validateBuildPackageRequirements, validateUploadRequirements } from "./package-requirements.js";

export type AdapterEnvironmentKind = "container" | "microvm" | "vm" | "host";
export type AdapterWorkloadClass = "web" | "sandbox" | "worker";
export type AdapterAccessMode = "http" | "http+websocket" | "none";
export type AdapterChallenge = "email_code" | "oidc" | "none";
/** Core 只解释基础字段；Adapter 自定义 kind 在默认表单中作为普通文本渲染。 */
export type AdapterAuthFieldKind = "email" | "verification_code" | "text" | (string & {});

export interface AdapterAuthField {
  readonly id: string;
  readonly kind: AdapterAuthFieldKind;
  readonly label: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly maxLength?: number;
}

export interface AdapterEntryManifest {
  readonly id: string;
  readonly label: string;
  readonly logoUrl: string;
  readonly challenge: AdapterChallenge;
  readonly defaultWorkspace: "personal";
  readonly fields?: readonly AdapterAuthField[];
}

/**
 * 适配器拥有的静态文件及其 Portal 公共路径。路径合同把产品资产留在
 * Adapter 发布包内，Core 只负责按命名空间复制，不把品牌文件写入自身源码。
 */
export interface AdapterAsset {
  /** 相对于 Adapter `assets/` 目录的安全路径。 */
  readonly path: string;
  /** 导出后由 Portal/Nginx 提供的绝对路径。 */
  readonly publicPath: string;
}

export interface AdapterAuthManifest {
  readonly providerId: string;
  readonly protocol: "email_code" | "oidc" | "none";
  readonly fields: readonly AdapterAuthField[];
  /** 仅用于兼容旧应用的下游 Cookie，不代表 Core 会转发凭证。 */
  readonly legacyHandoff?: boolean;
}

export interface AdapterWorkloadProfile {
  readonly runtimeContract: string;
  readonly environmentKind: AdapterEnvironmentKind;
  readonly workloadClass: AdapterWorkloadClass;
  readonly accessMode: AdapterAccessMode;
  readonly healthPath: string;
  readonly imageReference?: string;
  /**
   * Optional provider-neutral runtime shape.  When present it is copied into
   * the Core RuntimeProfile by the adapter bridge; it never contains a Docker
   * command or a product-specific implementation reference.
   */
  readonly runtime?: AdapterRuntimeProfile;
}

/**
 * The public, serialisable subset of a RuntimeProfile that an App adapter may
 * declare.  Keeping this in contracts lets an adapter ship independently of
 * Core's private TypeScript modules while still making mounts, health probes
 * and lock recovery explicit at composition time.
 */
export interface AdapterRuntimeProfile {
  readonly id: string;
  /** Must equal the enclosing workload.runtimeContract. */
  readonly contract: string;
  /** 运行时配置的环境变量命名空间；缺省时由 Core 使用 OPENAPP。 */
  readonly environmentPrefix?: string;
  /** 由适配器拥有的默认镜像和资源命名，不由 Core 按 App id 猜测。 */
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
  /** 镜像内恢复命令，省略时不执行应用级锁恢复。 */
  readonly recoveryCommand?: readonly string[];
  readonly configEnvironmentKey: string;
  readonly lockRecoveryEnvironment?: {
    readonly containers: string;
    readonly hosts: string;
    readonly recoveryId: string;
  };
  readonly reservedEnvironment: readonly string[];
  readonly healthPath: string;
  /** 需要注入工作负载的可选变量键。 */
  readonly providerEnvironment?: {
    readonly authProviderKey?: string;
    readonly allowedOriginsKey?: string;
    readonly mcpAppSandboxOriginKey?: string;
    readonly defaultAuthProviderBaseUrl?: string;
  };
  /** 迁移时可发现的旧资源命名空间，必须由适配器显式声明。 */
  readonly legacyResourcePrefixes?: {
    readonly network?: readonly string[];
    readonly container?: readonly string[];
    readonly volume?: readonly string[];
    readonly label?: readonly string[];
  };
}

export interface AdapterPackageRequirement {
  readonly key: string;
  readonly required: boolean;
  readonly acceptedExtensions: readonly string[];
  readonly maxBytes?: number;
}

export interface AdapterBuildProfile {
  readonly strategyId: string;
  readonly revision: number;
  readonly runtimeContract: string;
  readonly packageRequirements: readonly AdapterPackageRequirement[];
  readonly imagePrefix: string;
}

export interface AdapterCatalogBootstrap {
  readonly version: string;
  readonly imageReference: string;
  readonly runtimeContract: string;
}

/**
 * 适配器可声明的迁移保留对象。它只描述迁移证明需要保留的领域，不携带
 * SQL、凭据或可执行脚本；真正的迁移仍由 Core 的持久化端口负责。
 */
export type AdapterMigrationPreservedResource =
  | "users"
  | "identities"
  | "tenants"
  | "memberships"
  | "workspaces"
  | "volumes"
  | "revisions"
  | "rollouts"
  | "audit";

export type AdapterMigrationStrategy = "additive" | "transform";

/** 已审核的旧资源别名。别名只用于兼容识别，不会改变通用 Core 的默认值。 */
export interface AdapterLegacyAliases {
  readonly appIds?: readonly string[];
  readonly providerIds?: readonly string[];
  readonly environmentKeys?: readonly string[];
  readonly cookieNames?: readonly string[];
  readonly routeAliases?: readonly string[];
}

/**
 * 适配器可提供给入口和诊断页的安全错误文案。键和值均经过合同校验，
 * 不允许把 token、Cookie 或 HTML 片段穿过浏览器边界。
 */
export type AdapterErrorCatalog = Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * 迁移描述是证据索引，不是迁移执行器。checksum 必须对应外部适配器发布的
 * 实际迁移定义，Core 只保存并展示它，不会根据字符串执行任意代码。
 */
export interface AdapterMigrationPlan {
  readonly id: string;
  readonly fromSchema: string;
  readonly toSchema: string;
  readonly checksum: string;
  readonly strategy: AdapterMigrationStrategy;
  readonly preserves?: readonly AdapterMigrationPreservedResource[];
}

/**
 * Adapter 的兼容岛声明。它把旧命名、用户可见错误和迁移证据集中在外部
 * Adapter，通用 Core 不再按某个 App id 猜测历史行为。
 */
export interface AdapterCompatibility {
  readonly legacyAliases?: AdapterLegacyAliases;
  readonly errorCatalog?: AdapterErrorCatalog;
  readonly migration?: AdapterMigrationPlan;
}

/**
 * 旧入口别名的结构化声明。兼容路由仍由 Core 宿主注册，Adapter 只提供
 * 已审核的路径清单，不能把任意 handler 或脚本注入控制面。
 */
export interface LegacyRouteAliases {
  readonly control?: readonly string[];
  readonly auth?: readonly string[];
  readonly all?: readonly string[];
}

/**
 * 旧认证岛的运行时能力。Provider 和 handoff 复用公开合同，Cookie/路由
 * 别名只在该岛内可见；Core 不需要知道 具体产品协议的字段。
 */
export interface LegacyAuthAdapter {
  readonly providerId?: string;
  readonly cookieNames?: readonly string[];
  readonly routeAliases?: LegacyRouteAliases;
  readonly provider?: AdapterAuthProvider;
  readonly handoff?: AdapterAuthHandoff;
}

/** 旧目录/构建投影；所有默认值由 Adapter 明确提供，不由 Core 猜测。 */
export interface LegacyCatalogAdapter {
  readonly appId: string;
  readonly bootstrap?: AdapterCatalogBootstrap;
  readonly build?: AdapterBuildProfile;
  readonly defaultAppId?: string;
}

/** 旧 Runtime 的 profile 和资源别名；Core 只消费经过校验的 profile。 */
export interface LegacyRuntimeAdapter {
  readonly profile: AdapterRuntimeProfile;
  readonly resourcePrefixes?: AdapterRuntimeProfile["legacyResourcePrefixes"];
}

/**
 * 旧数据/错误的防腐投影。投影函数只接收和返回普通数据，不能取得数据库
 * 连接、Docker client 或请求对象；迁移执行仍由 Core 持久化端口负责。
 */
export interface LegacyProjectionAdapter {
  readonly id: string;
  readonly version: string;
  readonly projectApp?: (value: unknown) => unknown;
  readonly projectRuntimeStatus?: (value: unknown) => unknown;
  readonly projectAdminConfig?: (value: unknown) => Readonly<Record<string, unknown>>;
  /** 仅接收已过滤凭证的验证码结果，提供旧客户端需要的附加字段。 */
  readonly projectEmailCodeResponse?: (value: unknown) => Readonly<Record<string, unknown>>;
}

/**
 * 迁移适配器只提供受限的证据描述和纯变换。Core 不执行 Adapter 传入的 SQL、
 * shell 命令或任意网络调用，避免把旧应用实现变成平台执行权限。
 */
export interface LegacyMigrationAdapter {
  readonly plan: AdapterMigrationPlan;
  readonly transform?: (value: unknown) => unknown;
}

/**
 * 旧产品的兼容岛。该对象是可选的，普通 App 不需要实现；
 * 组合根可将它交给通用 Compatibility Host，而不把产品实现放回 Core。
 */
export interface AdapterLegacyIntegration {
  readonly routes?: LegacyRouteAliases;
  readonly auth?: LegacyAuthAdapter;
  readonly catalog?: LegacyCatalogAdapter;
  readonly runtime?: LegacyRuntimeAdapter;
  readonly projection?: LegacyProjectionAdapter;
  readonly migration?: LegacyMigrationAdapter;
}

export interface AppAdapterManifest {
  readonly id: string;
  readonly apiVersion: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly entry: AdapterEntryManifest;
  readonly assets?: readonly AdapterAsset[];
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly auth?: AdapterAuthManifest;
  readonly workload: AdapterWorkloadProfile;
  readonly build?: AdapterBuildProfile;
  readonly catalogBootstrap?: AdapterCatalogBootstrap;
  /** 适配器拥有的兼容元数据；缺省表示没有旧合同需要桥接。 */
  readonly compatibility?: AdapterCompatibility;
}

export interface AdapterAuthIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly email: string;
  readonly displayName?: string;
  readonly isNewUser?: boolean;
}

/** 凭证值只在适配器边界内流动，Core 不解释其内部字段。 */
export interface AdapterCredentialGrant {
  readonly kind: string;
  readonly provider: string;
  readonly expiresAt?: string;
  readonly [key: string]: unknown;
}

export interface AdapterAuthLoginInput {
  readonly email: string;
  readonly code: string;
  readonly providerData?: Readonly<Record<string, unknown>>;
}

export interface AdapterAuthEmailCodeResult {
  /** Provider 自有挑战状态；Core 只透传，不解释其字段。 */
  readonly providerData?: Readonly<Record<string, unknown>>;
  readonly isNewUser?: boolean;
}

export interface AdapterAuthLoginResult {
  readonly identity: AdapterAuthIdentity;
  readonly credentialGrant?: AdapterCredentialGrant;
}

export interface AdapterAuthProvider {
  readonly id: string;
  /** Provider 只声明公开错误码与 HTTP 状态，不向客户端透传异常详情。 */
  mapError?(error: unknown, operation: "email-code" | "login"): { readonly status: number; readonly code: string } | undefined;
  readonly presentation?: {
    readonly label: string;
    readonly iconUrl: string;
    readonly challenge: string;
    readonly fields?: readonly AdapterAuthField[];
    readonly capabilities?: Readonly<Record<string, boolean>>;
  };
  sendEmailCode(email: string): Promise<AdapterAuthEmailCodeResult | void>;
  login(input: AdapterAuthLoginInput): Promise<AdapterAuthLoginResult>;
  validateCredentialGrant?(grant: AdapterCredentialGrant): void;
  revokeCredentialGrant?(grant: AdapterCredentialGrant): Promise<void>;
  revokeSession?(refreshToken: string): Promise<void>;
}

export type AdapterAuthRevocationReason = "login_replaced" | "logout" | "materialize_failed";

export interface AdapterAuthHandoffInput {
  readonly cookieHeader?: string;
  readonly credentialGrant?: AdapterCredentialGrant;
  readonly sessionId: string;
  readonly secureCookies: boolean;
  readonly instanceIds?: readonly string[];
  readonly revokeCredentialGrant?: (
    grant: AdapterCredentialGrant,
    reason: AdapterAuthRevocationReason,
  ) => Promise<void>;
  /** 兼容旧 Provider 的 refresh token 回收回调；新适配器优先使用 grant。 */
  readonly revokeRefreshSession?: (
    refreshToken: string,
    reason: AdapterAuthRevocationReason,
  ) => Promise<void>;
}

export interface AdapterAuthLogoutInput {
  readonly cookieHeader?: string;
  readonly secureCookies: boolean;
  readonly instanceIds?: readonly string[];
  readonly revokeCredentialGrant?: (
    grant: AdapterCredentialGrant,
    reason: AdapterAuthRevocationReason,
  ) => Promise<void>;
  readonly revokeRefreshSession?: (
    refreshToken: string,
    reason: AdapterAuthRevocationReason,
  ) => Promise<void>;
}

export interface AdapterAuthProxyInput {
  readonly instanceId: string;
  readonly secureCookies: boolean;
}

export interface AdapterProxyOptions {
  readonly upstreamHost?: string;
  readonly upstreamHeaders?: Readonly<Record<string, string>>;
  readonly stripRequestCookies?: boolean;
  readonly stripCookieNames?: readonly string[];
  readonly stripResponseCookieNames?: readonly string[];
  readonly rootScopedCookieNames?: readonly string[];
  readonly httpOnlyRootScopedCookieNames?: readonly string[];
  readonly secureRootScopedCookies?: boolean;
}

export interface AdapterAuthHandoff {
  readonly appId: string;
  readonly managedCookieNames: readonly string[];
  onLogin(input: AdapterAuthHandoffInput): Promise<readonly string[]>;
  onLogout(input: AdapterAuthLogoutInput): Promise<readonly string[]>;
  proxyOptions(input: AdapterAuthProxyInput): Readonly<AdapterProxyOptions>;
  acceptsCredentialGrant?(grant: AdapterCredentialGrant): boolean;
  hasSession?(cookieHeader: string | undefined): boolean;
}

export interface AdapterReleaseInspector {
  /** 旧数据库列到命名槽位的显式映射，仅用于可回滚的加法迁移。 */
  readonly legacyPackageColumns?: Readonly<Record<string, string>>;
  /** 历史上传协议的字段与内容转换由插件声明，宿主只接收命名文件。 */
  readonly uploadRequirements?: readonly AdapterPackageRequirement[];
  inspectUpload?(paths: Readonly<Record<string, string>>, appId: string): Promise<import("./build.js").StrategyPackageInspection>;
}


export * from './build.js';

export interface AdapterModuleHost {
  readonly artifacts?: import('./build.js').AdapterBuildArtifacts;
  readonly runCommand?: import('./build.js').BuildCommandRunner;
  readonly buildScriptPath?: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly releaseInspector: AdapterReleaseInspector;
}

export interface OpenAppAdapter {
  readonly buildStrategy?: import('./build.js').BuildStrategyAdapter;
  readonly releaseInspector?: AdapterReleaseInspector;
  readonly manifest: AppAdapterManifest;
  readonly authProvider?: AdapterAuthProvider;
  readonly authHandoff?: AdapterAuthHandoff;
  readonly buildProfile?: AdapterBuildProfile;
  /** 可选的运行时兼容声明；若 manifest 也声明，二者必须完全一致。 */
  readonly compatibility?: AdapterCompatibility;
  /** 可选的运行时兼容岛；普通 App 无需携带任何 legacy 实现。 */
  readonly legacy?: AdapterLegacyIntegration;
}

export type OpenAppAdapterFactory = (host: AdapterModuleHost) => OpenAppAdapter;

export class AdapterManifestError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * 在 Core 和适配器之间的信任边界执行一次严格校验，避免数据库或环境变量
 * 直接改变可执行能力；校验失败必须阻止启动，而不是降级成部分成功。
 */
export function validateAdapterManifest(value: unknown): AppAdapterManifest {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_required");
  const id = normalizedId(value.id, "adapter_manifest_id_invalid");
  const apiVersion = normalizedText(value.apiVersion, "adapter_manifest_api_version_invalid");
  const version = normalizedText(value.version, "adapter_manifest_version_invalid");
  const name = normalizedText(value.name, "adapter_manifest_name_invalid");
  const description = text(value.description, "adapter_manifest_description_invalid");
  const entry = validateEntry(value.entry);
  const assets = value.assets === undefined ? undefined : validateAssets(value.assets, id);
  if (assets && entry.logoUrl.startsWith("/") && !assets.some((asset) => asset.publicPath === entry.logoUrl)) {
    throw new AdapterManifestError("adapter_manifest_entry_logo_asset_missing");
  }
  const workload = validateWorkload(value.workload);
  const capabilities = validateCapabilities(value.capabilities);
  const auth = value.auth === undefined ? undefined : validateAuth(value.auth);
  const build = value.build === undefined ? undefined : validateBuild(value.build);
  const catalogBootstrap = value.catalogBootstrap === undefined
    ? undefined
    : validateBootstrap(value.catalogBootstrap);
  const compatibility = value.compatibility === undefined
    ? undefined
    : validateAdapterCompatibility(value.compatibility);
  validateManifestRelationships(entry, auth, workload, build, catalogBootstrap);
  return {
    id,
    apiVersion,
    version,
    name,
    description,
    entry,
    ...(assets ? { assets } : {}),
    capabilities,
    ...(auth ? { auth } : {}),
    workload,
    ...(build ? { build } : {}),
    ...(catalogBootstrap ? { catalogBootstrap } : {}),
    ...(compatibility ? { compatibility } : {}),
  };
}

/**
 * 校验并归一化 Adapter 的兼容声明。该函数独立导出，供部署校验器和其他
 * 合规消费者在不加载 Core 私有实现的情况下复用同一安全边界。
 */
export function validateAdapterCompatibility(value: unknown): AdapterCompatibility {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_compatibility_invalid");
  rejectUnknownKeys(value, ["legacyAliases", "errorCatalog", "migration"], "adapter_manifest_compatibility_invalid");
  const legacyAliases = value.legacyAliases === undefined
    ? undefined
    : validateLegacyAliases(value.legacyAliases);
  const errorCatalog = value.errorCatalog === undefined
    ? undefined
    : validateErrorCatalog(value.errorCatalog);
  const migration = value.migration === undefined
    ? undefined
    : validateMigrationPlan(value.migration);
  return {
    ...(legacyAliases === undefined ? {} : { legacyAliases }),
    ...(errorCatalog === undefined ? {} : { errorCatalog }),
    ...(migration === undefined ? {} : { migration }),
  };
}

/**
 * 校验 Adapter 的运行时兼容岛。这里不执行任何函数，只检查其形状、身份和
 * 路径边界；真正的函数调用仍由 Core 的 Compatibility Host 按白名单进行。
 */
export function validateAdapterLegacy(value: unknown): AdapterLegacyIntegration {
  if (!record(value)) throw new AdapterManifestError("adapter_legacy_invalid");
  rejectUnknownKeys(value, ["routes", "auth", "catalog", "runtime", "projection", "migration"], "adapter_legacy_invalid");
  const routes = value.routes === undefined ? undefined : validateLegacyRoutes(value.routes);
  const auth = value.auth === undefined ? undefined : validateLegacyAuth(value.auth);
  const catalog = value.catalog === undefined ? undefined : validateLegacyCatalog(value.catalog);
  const runtime = value.runtime === undefined ? undefined : validateLegacyRuntime(value.runtime);
  const projection = value.projection === undefined ? undefined : validateLegacyProjection(value.projection);
  const migration = value.migration === undefined ? undefined : validateLegacyMigration(value.migration);
  const runtimeContracts = [
    catalog?.bootstrap?.runtimeContract,
    catalog?.build?.runtimeContract,
    runtime?.profile.contract,
  ].filter((contract): contract is string => Boolean(contract));
  if (new Set(runtimeContracts).size > 1) {
    throw new AdapterManifestError("adapter_legacy_runtime_contract_mismatch");
  }
  if (auth?.routeAliases && routes && JSON.stringify(auth.routeAliases) !== JSON.stringify(routes)) {
    throw new AdapterManifestError("adapter_legacy_route_alias_mismatch");
  }
  if (auth?.providerId && auth.provider
    && auth.providerId !== normalizeLegacyProviderId(auth.provider.id)) {
    throw new AdapterManifestError("adapter_legacy_auth_provider_mismatch");
  }
  if (auth?.cookieNames && auth.handoff
    && !sameLegacyCookieNames(auth.cookieNames, auth.handoff.managedCookieNames)) {
    throw new AdapterManifestError("adapter_legacy_auth_cookie_mismatch");
  }
  if (catalog?.defaultAppId && catalog.defaultAppId !== catalog.appId) {
    throw new AdapterManifestError("adapter_legacy_catalog_default_app_mismatch");
  }
  return {
    ...(routes === undefined ? {} : { routes }),
    ...(auth === undefined ? {} : { auth }),
    ...(catalog === undefined ? {} : { catalog }),
    ...(runtime === undefined ? {} : { runtime }),
    ...(projection === undefined ? {} : { projection }),
    ...(migration === undefined ? {} : { migration }),
  };
}

function validateLegacyRoutes(value: unknown): LegacyRouteAliases {
  if (!record(value)) throw new AdapterManifestError("adapter_legacy_routes_invalid");
  rejectUnknownKeys(value, ["control", "auth", "all"], "adapter_legacy_routes_invalid");
  const result: Record<string, readonly string[]> = {};
  for (const key of ["control", "auth", "all"] as const) {
    if (value[key] === undefined) continue;
    const paths = compatibilityAliasArray(
      value[key],
      "adapter_legacy_route_invalid",
      (item) => {
        const route = normalizedText(item, "adapter_legacy_route_invalid");
        if (!COMPATIBILITY_ROUTE_PATTERN.test(route) || route.includes("..")) {
          throw new AdapterManifestError("adapter_legacy_route_invalid");
        }
        return route;
      },
    );
    result[key] = paths;
  }
  return result as LegacyRouteAliases;
}

function validateLegacyAuth(value: unknown): LegacyAuthAdapter {
  if (!record(value)) throw new AdapterManifestError("adapter_legacy_auth_invalid");
  rejectUnknownKeys(value, ["providerId", "cookieNames", "routeAliases", "provider", "handoff"], "adapter_legacy_auth_invalid");
  const providerId = value.providerId === undefined ? undefined : normalizedId(value.providerId, "adapter_legacy_auth_provider_invalid");
  const cookieNames = value.cookieNames === undefined
    ? undefined
    : compatibilityAliasArray(value.cookieNames, "adapter_legacy_auth_cookie_invalid", (item) => {
      const name = normalizedText(item, "adapter_legacy_auth_cookie_invalid");
      if (!COMPATIBILITY_COOKIE_NAME_PATTERN.test(name)) throw new AdapterManifestError("adapter_legacy_auth_cookie_invalid");
      return name;
    });
  const routeAliases = value.routeAliases === undefined ? undefined : validateLegacyRoutes(value.routeAliases);
  if (value.provider !== undefined && (!record(value.provider)
    || typeof value.provider.id !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value.provider.id.trim())
    || typeof value.provider.sendEmailCode !== "function"
    || typeof value.provider.login !== "function")) {
    throw new AdapterManifestError("adapter_legacy_auth_provider_invalid");
  }
  if (value.handoff !== undefined && (!record(value.handoff)
    || typeof value.handoff.appId !== "string"
    || !/^[a-z0-9][a-z0-9._-]{0,127}$/iu.test(value.handoff.appId.trim())
    || !Array.isArray(value.handoff.managedCookieNames)
    || !validateLegacyHandoffCookieNames(value.handoff.managedCookieNames)
    || typeof value.handoff.onLogin !== "function"
    || typeof value.handoff.onLogout !== "function"
    || typeof value.handoff.proxyOptions !== "function")) {
    throw new AdapterManifestError("adapter_legacy_auth_handoff_invalid");
  }
  return {
    ...(providerId === undefined ? {} : { providerId }),
    ...(cookieNames === undefined ? {} : { cookieNames }),
    ...(routeAliases === undefined ? {} : { routeAliases }),
    ...(value.provider === undefined ? {} : { provider: value.provider as unknown as AdapterAuthProvider }),
    ...(value.handoff === undefined ? {} : { handoff: value.handoff as unknown as AdapterAuthHandoff }),
  };
}

function normalizeLegacyProviderId(value: string): string {
  return value.trim().toLowerCase();
}

function sameLegacyCookieNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightNames = new Set(right.map((name) => name.toLowerCase()));
  return left.every((name) => rightNames.has(name.toLowerCase()));
}

function validateLegacyHandoffCookieNames(value: readonly unknown[]): boolean {
  if (value.length > 64) return false;
  const names = value.map((name) => typeof name === "string" ? name.trim() : "");
  if (names.some((name) => !COMPATIBILITY_COOKIE_NAME_PATTERN.test(name))) return false;
  return new Set(names.map((name) => name.toLowerCase())).size === names.length;
}

function validateLegacyCatalog(value: unknown): LegacyCatalogAdapter {
  if (!record(value)) throw new AdapterManifestError("adapter_legacy_catalog_invalid");
  rejectUnknownKeys(value, ["appId", "bootstrap", "build", "defaultAppId"], "adapter_legacy_catalog_invalid");
  const appId = normalizedId(value.appId, "adapter_legacy_catalog_app_invalid");
  const defaultAppId = value.defaultAppId === undefined ? undefined : normalizedId(value.defaultAppId, "adapter_legacy_catalog_default_app_invalid");
  const bootstrap = value.bootstrap === undefined ? undefined : validateBootstrap(value.bootstrap);
  const build = value.build === undefined ? undefined : validateBuild(value.build);
  if (bootstrap && bootstrap.runtimeContract === "") throw new AdapterManifestError("adapter_legacy_catalog_bootstrap_invalid");
  if (build && build.runtimeContract === "") throw new AdapterManifestError("adapter_legacy_catalog_build_invalid");
  return {
    appId,
    ...(bootstrap === undefined ? {} : { bootstrap }),
    ...(build === undefined ? {} : { build }),
    ...(defaultAppId === undefined ? {} : { defaultAppId }),
  };
}

function validateLegacyRuntime(value: unknown): LegacyRuntimeAdapter {
  if (!record(value)) throw new AdapterManifestError("adapter_legacy_runtime_invalid");
  rejectUnknownKeys(value, ["profile", "resourcePrefixes"], "adapter_legacy_runtime_invalid");
  const profileValue = record(value.profile) ? value.profile : undefined;
  const profile = validateRuntimeProfile(
    value.profile,
    typeof profileValue?.healthPath === "string" ? profileValue.healthPath : "",
  );
  const resourcePrefixes = value.resourcePrefixes === undefined
    ? undefined
    : validateLegacyResourcePrefixes(value.resourcePrefixes);
  return {
    profile,
    ...(resourcePrefixes === undefined ? {} : { resourcePrefixes }),
  };
}

function validateLegacyProjection(value: unknown): LegacyProjectionAdapter {
  if (!record(value)) throw new AdapterManifestError("adapter_legacy_projection_invalid");
  rejectUnknownKeys(value, ["id", "version", "projectApp", "projectRuntimeStatus", "projectAdminConfig", "projectEmailCodeResponse"], "adapter_legacy_projection_invalid");
  const id = normalizedId(value.id, "adapter_legacy_projection_id_invalid");
  const version = normalizedText(value.version, "adapter_legacy_projection_version_invalid");
  for (const key of ["projectApp", "projectRuntimeStatus", "projectAdminConfig", "projectEmailCodeResponse"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "function") {
      throw new AdapterManifestError("adapter_legacy_projection_function_invalid");
    }
  }
  return {
    id,
    version,
    ...(value.projectApp === undefined ? {} : { projectApp: value.projectApp as (value: unknown) => unknown }),
    ...(value.projectRuntimeStatus === undefined ? {} : { projectRuntimeStatus: value.projectRuntimeStatus as (value: unknown) => unknown }),
    ...(value.projectAdminConfig === undefined ? {} : { projectAdminConfig: value.projectAdminConfig as (value: unknown) => Readonly<Record<string, unknown>> }),
    ...(value.projectEmailCodeResponse === undefined ? {} : { projectEmailCodeResponse: value.projectEmailCodeResponse as (value: unknown) => Readonly<Record<string, unknown>> }),
  };
}

function validateLegacyMigration(value: unknown): LegacyMigrationAdapter {
  if (!record(value)) throw new AdapterManifestError("adapter_legacy_migration_invalid");
  rejectUnknownKeys(value, ["plan", "transform"], "adapter_legacy_migration_invalid");
  const plan = validateMigrationPlan(value.plan);
  if (value.transform !== undefined && typeof value.transform !== "function") {
    throw new AdapterManifestError("adapter_legacy_migration_function_invalid");
  }
  return {
    plan,
    ...(value.transform === undefined ? {} : { transform: value.transform as (value: unknown) => unknown }),
  };
}

/**
 * 跨字段关系属于公开合同本身，不能依赖某一个 Core loader 补充校验；否则
 * Adapter 被其他合规消费者装载时，可能形成认证或 Runtime 各层不一致的组合。
 */
function validateManifestRelationships(
  entry: AdapterEntryManifest,
  auth: AdapterAuthManifest | undefined,
  workload: AdapterWorkloadProfile,
  build: AdapterBuildProfile | undefined,
  catalogBootstrap: AdapterCatalogBootstrap | undefined,
): void {
  if (entry.challenge !== (auth?.protocol ?? "none")) {
    throw new AdapterManifestError("adapter_manifest_auth_challenge_mismatch");
  }
  if (workload.runtime && workload.runtime.contract !== workload.runtimeContract) {
    throw new AdapterManifestError("adapter_manifest_runtime_contract_mismatch");
  }
  if (build && build.runtimeContract !== workload.runtimeContract) {
    throw new AdapterManifestError("adapter_manifest_build_runtime_mismatch");
  }
  if (catalogBootstrap && catalogBootstrap.runtimeContract !== workload.runtimeContract) {
    throw new AdapterManifestError("adapter_manifest_bootstrap_runtime_mismatch");
  }
}

function validateEntry(value: unknown): AdapterEntryManifest {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_entry_invalid");
  const id = normalizedId(value.id, "adapter_manifest_entry_id_invalid");
  const label = normalizedText(value.label, "adapter_manifest_entry_label_invalid");
  const logoUrl = assetUrl(value.logoUrl, "adapter_manifest_entry_logo_invalid");
  const challenge = value.challenge;
  if (challenge !== "email_code" && challenge !== "oidc" && challenge !== "none") {
    throw new AdapterManifestError("adapter_manifest_entry_challenge_invalid");
  }
  if (value.defaultWorkspace !== "personal") {
    throw new AdapterManifestError("adapter_manifest_entry_workspace_invalid");
  }
  const fields = value.fields === undefined ? undefined : validateFields(value.fields);
  return { id, label, logoUrl, challenge, defaultWorkspace: "personal", ...(fields ? { fields } : {}) };
}

function validateAssets(value: unknown, adapterId: string): AdapterAsset[] {
  if (!Array.isArray(value) || value.length > 128) {
    throw new AdapterManifestError("adapter_manifest_assets_invalid");
  }
  const assets = value.map((item) => {
    if (!record(item)) throw new AdapterManifestError("adapter_manifest_asset_invalid");
    const path = assetSourcePath(item.path, "adapter_manifest_asset_path_invalid");
    const publicPath = assetPublicPath(item.publicPath, adapterId, "adapter_manifest_asset_public_path_invalid");
    return { path, publicPath };
  });
  if (new Set(assets.map((asset) => asset.path)).size !== assets.length
    || new Set(assets.map((asset) => asset.publicPath)).size !== assets.length) {
    throw new AdapterManifestError("adapter_manifest_assets_duplicate");
  }
  return assets;
}

function validateAuth(value: unknown): AdapterAuthManifest {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_auth_invalid");
  const providerId = normalizedId(value.providerId, "adapter_manifest_auth_provider_invalid");
  const protocol = value.protocol;
  if (protocol !== "email_code" && protocol !== "oidc" && protocol !== "none") {
    throw new AdapterManifestError("adapter_manifest_auth_protocol_invalid");
  }
  const fields = validateFields(value.fields);
  const legacyHandoff = value.legacyHandoff === undefined ? undefined : boolean(value.legacyHandoff, "adapter_manifest_auth_legacy_invalid");
  return { providerId, protocol, fields, ...(legacyHandoff === undefined ? {} : { legacyHandoff }) };
}

function validateWorkload(value: unknown): AdapterWorkloadProfile {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_workload_invalid");
  const runtimeContract = normalizedId(value.runtimeContract, "adapter_manifest_runtime_contract_invalid");
  const environmentKind = value.environmentKind;
  const workloadClass = value.workloadClass;
  const accessMode = value.accessMode;
  if (environmentKind !== "container" && environmentKind !== "microvm" && environmentKind !== "vm" && environmentKind !== "host") {
    throw new AdapterManifestError("adapter_manifest_environment_kind_invalid");
  }
  if (workloadClass !== "web" && workloadClass !== "sandbox" && workloadClass !== "worker") {
    throw new AdapterManifestError("adapter_manifest_workload_class_invalid");
  }
  if (accessMode !== "http" && accessMode !== "http+websocket" && accessMode !== "none") {
    throw new AdapterManifestError("adapter_manifest_access_mode_invalid");
  }
  const healthPath = normalizedPath(value.healthPath, "adapter_manifest_health_path_invalid");
  const imageReference = value.imageReference === undefined
    ? undefined
    : normalizedText(value.imageReference, "adapter_manifest_image_invalid");
  const runtime = value.runtime === undefined
    ? undefined
    : validateRuntimeProfile(value.runtime, healthPath);
  return {
    runtimeContract,
    environmentKind,
    workloadClass,
    accessMode,
    healthPath,
    ...(imageReference ? { imageReference } : {}),
    ...(runtime ? { runtime } : {}),
  };
}

function validateRuntimeProfile(value: unknown, workloadHealthPath: string): AdapterRuntimeProfile {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_runtime_profile_invalid");
  const id = normalizedId(value.id, "adapter_manifest_runtime_profile_id_invalid");
  const contract = normalizedId(value.contract, "adapter_manifest_runtime_profile_contract_invalid");
  const environmentPrefix = value.environmentPrefix === undefined
    ? undefined
    : environmentPrefixValue(value.environmentPrefix, "adapter_manifest_runtime_environment_prefix_invalid");
  const defaultImage = value.defaultImage === undefined
    ? undefined
    : normalizedText(value.defaultImage, "adapter_manifest_runtime_image_invalid");
  if (defaultImage !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u.test(defaultImage)) {
    throw new AdapterManifestError("adapter_manifest_runtime_image_invalid");
  }
  const defaultNetworkPrefix = optionalResourcePrefix(value.defaultNetworkPrefix, "adapter_manifest_runtime_network_prefix_invalid");
  const defaultContainerPrefix = optionalResourcePrefix(value.defaultContainerPrefix, "adapter_manifest_runtime_container_prefix_invalid");
  const defaultVolumePrefix = optionalResourcePrefix(value.defaultVolumePrefix, "adapter_manifest_runtime_volume_prefix_invalid");
  const labelPrefix = normalizedText(value.labelPrefix, "adapter_manifest_runtime_label_invalid");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(labelPrefix)) {
    throw new AdapterManifestError("adapter_manifest_runtime_label_invalid");
  }
  const storageClass = normalizedId(value.storageClass, "adapter_manifest_runtime_storage_class_invalid");
  const storageMountPath = normalizedPath(value.storageMountPath, "adapter_manifest_runtime_storage_path_invalid");
  const containerPort = positiveInteger(value.containerPort, "adapter_manifest_runtime_port_invalid");
  if (containerPort > 65_535) throw new AdapterManifestError("adapter_manifest_runtime_port_invalid");
  const containerUser = normalizedText(value.containerUser, "adapter_manifest_runtime_user_invalid");
  if (!/^[a-z_][a-z0-9_-]{0,63}$/iu.test(containerUser)) {
    throw new AdapterManifestError("adapter_manifest_runtime_user_invalid");
  }
  const entrypoint = normalizedPath(value.entrypoint, "adapter_manifest_runtime_entrypoint_invalid");
  const command = stringArray(value.command, "adapter_manifest_runtime_command_invalid", 64, 1);
  if (value.recoveryScript !== undefined) {
    throw new AdapterManifestError("adapter_manifest_runtime_recovery_command_required");
  }
  const recoveryCommand = value.recoveryCommand === undefined ? undefined
    : stringArray(value.recoveryCommand, "adapter_manifest_runtime_recovery_invalid", 64, 1);
  const configEnvironmentKey = environmentName(value.configEnvironmentKey, "adapter_manifest_runtime_environment_invalid");
  if ((recoveryCommand === undefined) !== (value.lockRecoveryEnvironment === undefined)
    || (value.lockRecoveryEnvironment !== undefined && !record(value.lockRecoveryEnvironment))) {
    throw new AdapterManifestError("adapter_manifest_runtime_lock_environment_invalid");
  }
  const lockRecoveryEnvironment = !record(value.lockRecoveryEnvironment) ? undefined : {
    containers: environmentName(value.lockRecoveryEnvironment.containers, "adapter_manifest_runtime_lock_environment_invalid"),
    hosts: environmentName(value.lockRecoveryEnvironment.hosts, "adapter_manifest_runtime_lock_environment_invalid"),
    recoveryId: environmentName(value.lockRecoveryEnvironment.recoveryId, "adapter_manifest_runtime_lock_environment_invalid"),
  };
  const reservedEnvironment = stringArray(
    value.reservedEnvironment,
    "adapter_manifest_runtime_reserved_environment_invalid",
    128,
  ).map((name) => environmentName(name, "adapter_manifest_runtime_reserved_environment_invalid"));
  if (new Set(reservedEnvironment).size !== reservedEnvironment.length) {
    throw new AdapterManifestError("adapter_manifest_runtime_reserved_environment_invalid");
  }
  const healthPath = normalizedPath(value.healthPath, "adapter_manifest_runtime_health_path_invalid");
  if (healthPath !== workloadHealthPath) {
    throw new AdapterManifestError("adapter_manifest_runtime_health_path_mismatch");
  }
  const providerEnvironment = value.providerEnvironment === undefined
    ? undefined
    : validateProviderEnvironment(value.providerEnvironment);
  const legacyResourcePrefixes = value.legacyResourcePrefixes === undefined
    ? undefined
    : validateLegacyResourcePrefixes(value.legacyResourcePrefixes);
  return {
    id,
    contract,
    ...(environmentPrefix === undefined ? {} : { environmentPrefix }),
    ...(defaultImage === undefined ? {} : { defaultImage }),
    ...(defaultNetworkPrefix === undefined ? {} : { defaultNetworkPrefix }),
    ...(defaultContainerPrefix === undefined ? {} : { defaultContainerPrefix }),
    ...(defaultVolumePrefix === undefined ? {} : { defaultVolumePrefix }),
    labelPrefix,
    storageClass,
    storageMountPath,
    containerPort,
    containerUser,
    entrypoint,
    command,
    ...(recoveryCommand ? { recoveryCommand } : {}),
    configEnvironmentKey,
    ...(lockRecoveryEnvironment ? { lockRecoveryEnvironment } : {}),
    reservedEnvironment,
    healthPath,
    ...(providerEnvironment === undefined ? {} : { providerEnvironment }),
    ...(legacyResourcePrefixes === undefined ? {} : { legacyResourcePrefixes }),
  };
}

function environmentPrefixValue(value: unknown, code: string): string {
  const prefix = normalizedText(value, code);
  if (!/^[A-Z][A-Z0-9_]{0,31}$/u.test(prefix)) throw new AdapterManifestError(code);
  return prefix;
}

function optionalResourcePrefix(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  const prefix = normalizedText(value, code);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(prefix)) throw new AdapterManifestError(code);
  return prefix;
}

function validateProviderEnvironment(value: unknown): NonNullable<AdapterRuntimeProfile["providerEnvironment"]> {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_runtime_provider_environment_invalid");
  const keys = ["authProviderKey", "allowedOriginsKey", "mcpAppSandboxOriginKey"] as const;
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (value[key] === undefined) continue;
    result[key] = environmentName(value[key], "adapter_manifest_runtime_provider_environment_invalid");
  }
  if (value.defaultAuthProviderBaseUrl !== undefined) {
    const url = normalizedText(value.defaultAuthProviderBaseUrl, "adapter_manifest_runtime_provider_url_invalid");
    try { new URL(url); } catch { throw new AdapterManifestError("adapter_manifest_runtime_provider_url_invalid"); }
    result.defaultAuthProviderBaseUrl = url;
  }
  return result as NonNullable<AdapterRuntimeProfile["providerEnvironment"]>;
}

function validateLegacyResourcePrefixes(value: unknown): NonNullable<AdapterRuntimeProfile["legacyResourcePrefixes"]> {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_runtime_legacy_prefixes_invalid");
  const result: Record<string, readonly string[]> = {};
  for (const key of ["network", "container", "volume", "label"] as const) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].length > 32) {
      throw new AdapterManifestError("adapter_manifest_runtime_legacy_prefixes_invalid");
    }
    const prefixes = value[key].map((item) => {
      const prefix = normalizedText(item, "adapter_manifest_runtime_legacy_prefix_invalid");
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(prefix)) {
        throw new AdapterManifestError("adapter_manifest_runtime_legacy_prefix_invalid");
      }
      return prefix;
    });
    if (new Set(prefixes).size !== prefixes.length) {
      throw new AdapterManifestError("adapter_manifest_runtime_legacy_prefixes_invalid");
    }
    result[key] = prefixes;
  }
  return result as NonNullable<AdapterRuntimeProfile["legacyResourcePrefixes"]>;
}

function validateBuild(value: unknown): AdapterBuildProfile {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_build_invalid");
  const strategyId = normalizedId(value.strategyId, "adapter_manifest_build_strategy_invalid");
  const revision = positiveInteger(value.revision, "adapter_manifest_build_revision_invalid");
  const runtimeContract = normalizedId(value.runtimeContract, "adapter_manifest_build_runtime_invalid");
  const packageRequirements = validatePackageRequirements(value.packageRequirements);
  const imagePrefix = normalizedId(value.imagePrefix, "adapter_manifest_build_image_prefix_invalid");
  return {
    strategyId,
    revision,
    runtimeContract,
    packageRequirements,
    imagePrefix,
  };
}

function validateBootstrap(value: unknown): AdapterCatalogBootstrap {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_bootstrap_invalid");
  return {
    version: normalizedText(value.version, "adapter_manifest_bootstrap_version_invalid"),
    imageReference: normalizedText(value.imageReference, "adapter_manifest_bootstrap_image_invalid"),
    runtimeContract: normalizedId(value.runtimeContract, "adapter_manifest_bootstrap_runtime_invalid"),
  };
}

function validatePackageRequirements(value: unknown): AdapterPackageRequirement[] {
  try { return validateBuildPackageRequirements(value); }
  catch { throw new AdapterManifestError("adapter_manifest_package_requirements_invalid"); }
}

function validateFields(value: unknown): AdapterAuthField[] {
  if (!Array.isArray(value) || value.length > 32) throw new AdapterManifestError("adapter_manifest_auth_fields_invalid");
  const fields = value.map((item) => {
    if (!record(item)) throw new AdapterManifestError("adapter_manifest_auth_field_invalid");
    const id = normalizedFieldId(item.id, "adapter_manifest_auth_field_id_invalid");
    const kind = item.kind;
    if (typeof kind !== "string" || !/^[a-z][a-z0-9_]{0,63}$/u.test(kind)) {
      throw new AdapterManifestError("adapter_manifest_auth_field_kind_invalid");
    }
    const fieldKind: AdapterAuthFieldKind = kind;
    const label = normalizedText(item.label, "adapter_manifest_auth_field_label_invalid");
    const placeholder = item.placeholder === undefined
      ? undefined
      : text(item.placeholder, "adapter_manifest_auth_field_placeholder_invalid");
    const required = item.required === undefined ? undefined : boolean(item.required, "adapter_manifest_auth_field_required_invalid");
    const secret = item.secret === undefined ? undefined : boolean(item.secret, "adapter_manifest_auth_field_secret_invalid");
    const maxLength = item.maxLength === undefined ? undefined : positiveInteger(item.maxLength, "adapter_manifest_auth_field_length_invalid");
    return {
      id,
      kind: fieldKind,
      label,
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(required === undefined ? {} : { required }),
      ...(secret === undefined ? {} : { secret }),
      ...(maxLength === undefined ? {} : { maxLength }),
    };
  });
  if (new Set(fields.map((item) => item.id)).size !== fields.length) {
    throw new AdapterManifestError("adapter_manifest_auth_field_duplicate");
  }
  return fields;
}

function validateCapabilities(value: unknown): Readonly<Record<string, boolean>> {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_capabilities_invalid");
  const result: Record<string, boolean> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(key) || typeof item !== "boolean") {
      throw new AdapterManifestError("adapter_manifest_capabilities_invalid");
    }
    result[key] = item;
  }
  return result;
}

const COMPATIBILITY_ALIAS_LIMIT = 32;
const COMPATIBILITY_LOCALE_LIMIT = 16;
const COMPATIBILITY_ERROR_LIMIT = 128;
const COMPATIBILITY_ERROR_TEXT_LIMIT = 512;
const COMPATIBILITY_LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8}){0,3}$/u;
const COMPATIBILITY_ERROR_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u;
const COMPATIBILITY_ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/u;
const COMPATIBILITY_COOKIE_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,128}$/u;
const COMPATIBILITY_ROUTE_PATTERN = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]{1,255}$/u;
const COMPATIBILITY_SCHEMA_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COMPATIBILITY_SENSITIVE_KEY_PATTERN = /(?:access|authorization|cookie|credential|password|private|refresh|secret|session|token)/iu;
const COMPATIBILITY_PRESERVED_RESOURCES: readonly AdapterMigrationPreservedResource[] = [
  "users",
  "identities",
  "tenants",
  "memberships",
  "workspaces",
  "volumes",
  "revisions",
  "rollouts",
  "audit",
];

function validateLegacyAliases(value: unknown): AdapterLegacyAliases {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_compatibility_aliases_invalid");
  rejectUnknownKeys(
    value,
    ["appIds", "providerIds", "environmentKeys", "cookieNames", "routeAliases"],
    "adapter_manifest_compatibility_aliases_invalid",
  );
  const appIds = value.appIds === undefined
    ? undefined
    : compatibilityAliasArray(value.appIds, "adapter_manifest_compatibility_app_alias_invalid", (item) => normalizedId(item, "adapter_manifest_compatibility_app_alias_invalid"));
  const providerIds = value.providerIds === undefined
    ? undefined
    : compatibilityAliasArray(value.providerIds, "adapter_manifest_compatibility_provider_alias_invalid", (item) => normalizedId(item, "adapter_manifest_compatibility_provider_alias_invalid"));
  const environmentKeys = value.environmentKeys === undefined
    ? undefined
    : compatibilityAliasArray(value.environmentKeys, "adapter_manifest_compatibility_environment_alias_invalid", (item) => {
      const key = normalizedText(item, "adapter_manifest_compatibility_environment_alias_invalid");
      if (!COMPATIBILITY_ENVIRONMENT_KEY_PATTERN.test(key)) {
        throw new AdapterManifestError("adapter_manifest_compatibility_environment_alias_invalid");
      }
      return key;
    });
  const cookieNames = value.cookieNames === undefined
    ? undefined
    : compatibilityAliasArray(value.cookieNames, "adapter_manifest_compatibility_cookie_alias_invalid", (item) => {
      const name = normalizedText(item, "adapter_manifest_compatibility_cookie_alias_invalid");
      if (!COMPATIBILITY_COOKIE_NAME_PATTERN.test(name)) {
        throw new AdapterManifestError("adapter_manifest_compatibility_cookie_alias_invalid");
      }
      return name;
    });
  const routeAliases = value.routeAliases === undefined
    ? undefined
    : compatibilityAliasArray(value.routeAliases, "adapter_manifest_compatibility_route_alias_invalid", (item) => {
      const route = normalizedText(item, "adapter_manifest_compatibility_route_alias_invalid");
      if (!COMPATIBILITY_ROUTE_PATTERN.test(route) || route.includes("..")) {
        throw new AdapterManifestError("adapter_manifest_compatibility_route_alias_invalid");
      }
      return route;
    });
  return {
    ...(appIds === undefined ? {} : { appIds }),
    ...(providerIds === undefined ? {} : { providerIds }),
    ...(environmentKeys === undefined ? {} : { environmentKeys }),
    ...(cookieNames === undefined ? {} : { cookieNames }),
    ...(routeAliases === undefined ? {} : { routeAliases }),
  };
}

function compatibilityAliasArray(
  value: unknown,
  invalidCode: string,
  normalize: (value: unknown) => string,
): string[] {
  if (!Array.isArray(value) || value.length > COMPATIBILITY_ALIAS_LIMIT) {
    throw new AdapterManifestError(invalidCode);
  }
  const aliases = value.map(normalize);
  if (new Set(aliases).size !== aliases.length) {
    throw new AdapterManifestError("adapter_manifest_compatibility_alias_duplicate");
  }
  return aliases;
}

function validateErrorCatalog(value: unknown): AdapterErrorCatalog {
  if (!record(value)
    || Object.keys(value).length === 0
    || Object.keys(value).length > COMPATIBILITY_LOCALE_LIMIT) {
    throw new AdapterManifestError("adapter_manifest_compatibility_error_catalog_invalid");
  }
  const catalog: Record<string, Readonly<Record<string, string>>> = {};
  const localeKeys = new Set<string>();
  for (const [locale, rawMessages] of Object.entries(value)) {
    const normalizedLocale = locale.trim();
    if (!COMPATIBILITY_LOCALE_PATTERN.test(normalizedLocale)) {
      throw new AdapterManifestError("adapter_manifest_compatibility_error_locale_invalid");
    }
    // locale 名称大小写不影响语言选择，等价名称不能在合并时静默覆盖。
    const localeKey = normalizedLocale.toLowerCase();
    if (localeKeys.has(localeKey)) {
      throw new AdapterManifestError("adapter_manifest_compatibility_error_locale_duplicate");
    }
    localeKeys.add(localeKey);
    if (!record(rawMessages) || Object.keys(rawMessages).length > COMPATIBILITY_ERROR_LIMIT) {
      throw new AdapterManifestError("adapter_manifest_compatibility_error_catalog_invalid");
    }
    if (Object.keys(rawMessages).length === 0) {
      throw new AdapterManifestError("adapter_manifest_compatibility_error_catalog_invalid");
    }
    const messages: Record<string, string> = {};
    const messageKeys = new Set<string>();
    for (const [rawKey, rawMessage] of Object.entries(rawMessages)) {
      const key = rawKey.trim().toLowerCase();
      if (!COMPATIBILITY_ERROR_KEY_PATTERN.test(key)
        || COMPATIBILITY_SENSITIVE_KEY_PATTERN.test(key)) {
        throw new AdapterManifestError("adapter_manifest_compatibility_error_key_invalid");
      }
      if (messageKeys.has(key)) {
        throw new AdapterManifestError("adapter_manifest_compatibility_error_key_duplicate");
      }
      messageKeys.add(key);
      if (typeof rawMessage !== "string"
        || rawMessage.trim().length === 0
        || rawMessage.length > COMPATIBILITY_ERROR_TEXT_LIMIT
        || /[<>\u0000-\u001f\u007f]/u.test(rawMessage)) {
        throw new AdapterManifestError("adapter_manifest_compatibility_error_value_invalid");
      }
      messages[key] = rawMessage;
    }
    catalog[normalizedLocale] = messages;
  }
  return catalog;
}

function validateMigrationPlan(value: unknown): AdapterMigrationPlan {
  if (!record(value)) throw new AdapterManifestError("adapter_manifest_compatibility_migration_invalid");
  rejectUnknownKeys(
    value,
    ["id", "fromSchema", "toSchema", "checksum", "strategy", "preserves"],
    "adapter_manifest_compatibility_migration_invalid",
  );
  const id = compatibilitySchemaValue(value.id, "adapter_manifest_compatibility_migration_id_invalid");
  const fromSchema = compatibilitySchemaValue(value.fromSchema, "adapter_manifest_compatibility_migration_from_invalid");
  const toSchema = compatibilitySchemaValue(value.toSchema, "adapter_manifest_compatibility_migration_to_invalid");
  if (fromSchema === toSchema) {
    throw new AdapterManifestError("adapter_manifest_compatibility_migration_schema_same");
  }
  const checksum = normalizedText(value.checksum, "adapter_manifest_compatibility_migration_checksum_invalid").toLowerCase();
  if (!/^(?:sha256:)?[a-f0-9]{64}$/u.test(checksum)) {
    throw new AdapterManifestError("adapter_manifest_compatibility_migration_checksum_invalid");
  }
  const strategy = value.strategy;
  if (strategy !== "additive" && strategy !== "transform") {
    throw new AdapterManifestError("adapter_manifest_compatibility_migration_strategy_invalid");
  }
  const preserves = value.preserves === undefined
    ? undefined
    : validatePreservedResources(value.preserves);
  return {
    id,
    fromSchema,
    toSchema,
    checksum,
    strategy,
    ...(preserves === undefined ? {} : { preserves }),
  };
}

function compatibilitySchemaValue(value: unknown, code: string): string {
  const normalized = normalizedText(value, code);
  if (!COMPATIBILITY_SCHEMA_PATTERN.test(normalized)) throw new AdapterManifestError(code);
  return normalized;
}

function validatePreservedResources(value: unknown): AdapterMigrationPreservedResource[] {
  if (!Array.isArray(value) || value.length > COMPATIBILITY_PRESERVED_RESOURCES.length) {
    throw new AdapterManifestError("adapter_manifest_compatibility_migration_preserves_invalid");
  }
  const preserves = value.map((item) => {
    if (!COMPATIBILITY_PRESERVED_RESOURCES.includes(item as AdapterMigrationPreservedResource)) {
      throw new AdapterManifestError("adapter_manifest_compatibility_migration_preserves_invalid");
    }
    return item as AdapterMigrationPreservedResource;
  });
  if (new Set(preserves).size !== preserves.length) {
    throw new AdapterManifestError("adapter_manifest_compatibility_migration_preserves_invalid");
  }
  return preserves;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new AdapterManifestError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function text(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length > 2_000 || /[\r\n]/u.test(value)) throw new AdapterManifestError(code);
  return value;
}

function normalizedText(value: unknown, code: string): string {
  const normalized = text(value, code).trim();
  if (!normalized) throw new AdapterManifestError(code);
  return normalized;
}

function normalizedId(value: unknown, code: string): string {
  const normalized = normalizedText(value, code).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(normalized)) throw new AdapterManifestError(code);
  return normalized;
}

function normalizedFieldId(value: unknown, code: string): string {
  const normalized = normalizedText(value, code);
  if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(normalized)) throw new AdapterManifestError(code);
  return normalized;
}

function normalizedPath(value: unknown, code: string): string {
  const normalized = normalizedText(value, code);
  if (!normalized.startsWith("/") || normalized.includes("..") || normalized.includes("\\")) {
    throw new AdapterManifestError(code);
  }
  return normalized;
}

function assetUrl(value: unknown, code: string): string {
  const normalized = normalizedText(value, code);
  if (normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AdapterManifestError(code);
  }
  if (normalized.startsWith("/")) {
    // 浏览器会先解码 URL；拒绝编码后的点段和反斜杠，避免静态路径绕过
    // 导出器的目录边界。查询参数允许用于版本化缓存键。
    const path = normalized.split(/[?#]/u, 1)[0] ?? "";
    if (!path || path.includes("\\") || /(?:^|\/)(?:\.{1,2})(?:\/|$)/u.test(path)
      || /%2e|%2f|%5c/iu.test(path)) {
      throw new AdapterManifestError(code);
    }
    return normalized;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new AdapterManifestError(code);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password
    || /[\u0000-\u001f\u007f]/u.test(parsed.href)) {
    throw new AdapterManifestError(code);
  }
  return normalized;
}

function assetSourcePath(value: unknown, code: string): string {
  const normalized = normalizedText(value, code);
  if (normalized.length > 512 || normalized.startsWith("/") || normalized.includes("\\")
    || normalized.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")
    || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new AdapterManifestError(code);
  }
  return normalized;
}

function assetPublicPath(value: unknown, adapterId: string, code: string): string {
  const normalized = assetUrl(value, code);
  const prefix = `/adapter-assets/${adapterId}/`;
  if (!normalized.startsWith(prefix) || normalized.slice(prefix.length).split(/[?#]/u)[0]?.length === 0) {
    throw new AdapterManifestError(code);
  }
  return normalized;
}

function environmentName(value: unknown, code: string): string {
  const normalized = normalizedText(value, code);
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(normalized)) throw new AdapterManifestError(code);
  return normalized;
}

function stringArray(
  value: unknown,
  code: string,
  maximum: number,
  minimum = 0,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new AdapterManifestError(code);
  }
  return value.map((item) => {
    const normalized = normalizedText(item, code);
    if (normalized.includes("\0")) throw new AdapterManifestError(code);
    return normalized;
  });
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new AdapterManifestError(code);
  return value as number;
}

function boolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new AdapterManifestError(code);
  return value;
}
