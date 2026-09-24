import { loadGenericConfig, type PortalConfig } from "./config-core.js";
import { AuthProviderRegistry } from "./auth/provider-registry.js";
import type { AuthProviderRegistryOptions } from "./auth/provider-registry.js";
import type { AuthService } from "./auth/types.js";
import { createGenericAuthService } from "./auth/core.js";
import { PortalAuth } from "./auth/portal-auth.js";
import {
  genericProviderAuthCompatibility,
  type ProviderAuthCompatibility,
} from "./auth/provider-compatibility.js";
import { createGenericPortalStores } from "./stores-core.js";
import type { PortalStores } from "./stores-contracts.js";
import { createContainerRuntime, type ContainerRuntime } from "./runtime.js";
import { InstanceLifecycle, type LifecycleAudit } from "./instance-lifecycle.js";
import { ForwardingPolicyManager } from "./forwarding-policy.js";
import {
  AppAuthHandoffCoordinator,
  AppAuthHandoffRegistry,
} from "./auth/app-auth-handoff.js";
import { AdminMonitoring } from "./admin-monitoring.js";
import { AdminOperationManager, operationStoreFromAdmin } from "./admin-operations.js";
import { AppCatalog } from "./app-catalog.js";
import { ImageBuildManager } from "./image-builds.js";
import { BuildStrategyRegistry } from "./build-strategies.js";
import { ImageBuildExecutor } from "./image-build-executor.js";
import { BuildPackageStorage } from "./build-package-upload.js";
import { AppImageUpdateCoordinator } from "./app-image-updates.js";
import { ResourceCleanupManager } from "./resource-cleanup.js";
import {
  InstanceActivityTracker,
  type InstanceActivityMonitor,
  InstanceUpgradeActivityPolicy,
  InstanceUpgradeAdmission,
} from "./instance-upgrade-activity.js";
import {
  UpgradeRolloutService,
  UpgradeRolloutWorker,
  upgradeInstanceLeaseName,
} from "./upgrade-rollouts.js";
import { DockerProviderAdapter } from "./docker-provider-adapter.js";
import { DockerArtifactAdapter, type OciArtifactManagementPort } from "./artifact-provider.js";
import type {
  AccessTargetResolver,
  ExecutionProviderPorts,
  ProviderDiagnosticsPort,
  ProviderHealthPort,
  ProviderMetricsPort,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort,
} from "./execution-provider.js";
import { WorkspaceExecutionManager } from "./workspace-execution-manager.js";
import { WorkspaceExecutionRuntimeBridge } from "./workspace-execution-runtime-bridge.js";
import { toLaunchProfile } from "./instance-policy.js";
import { PlatformPluginRegistry, type AppIntegrationPlugin } from "./platform-plugins.js";
import { TenantMembershipService } from "./tenant-membership.js";
import {
  ExternalAdapterError,
  loadExternalAppAdapter,
} from "./external-adapter.js";
import type { BuildCommandRunner } from "./build-strategies.js";
import type { AdapterReleaseInspector } from "@openapp/contracts";
import {
  adaptExecutionProvider,
  ExecutionProviderRegistry,
  type ExecutionProviderAdapterInput,
} from "./execution-provider-registry.js";
import type { QuotaAdmission } from "./quota-admission.js";
import { createConfiguredPersistence } from "./persistence/factory.js";
import {
  GENERIC_PORTAL_COMPATIBILITY_BOUNDARY,
  type PortalCompatibilityBoundary,
} from "./portal-compatibility.js";
import { createLegacyPortalCompatibilityBoundary } from "./legacy-host.js";
import {
  GENERIC_RUNTIME_PROFILE,
  type RuntimeProfile,
} from "@openapp/container-runtime";

/** @deprecated 使用 `ExecutionProviderPorts`；保留此名称以兼容旧源码调用方。 */
export type PortalExecutionProvider = ExecutionProviderPorts;

export interface PortalContextOptions {
  config?: PortalConfig;
  stores?: PortalStores;
  runtime?: ContainerRuntime;
  executionProvider?: ExecutionProviderPorts;
  artifacts?: OciArtifactManagementPort;
  providerMetrics?: ProviderMetricsPort;
  providerDiagnostics?: ProviderDiagnosticsPort;
  providerHealth?: ProviderHealthPort;
  accessTargetResolver?: AccessTargetResolver;
  executionManager?: WorkspaceExecutionManager;
  /** 仅用于紧急回切；新部署默认通过 Execution Manager。 */
  useLegacyLifecycleRuntime?: boolean;
  auth?: AuthService;
  /** 可跨 App 共享的、平台级外部认证注册表。 */
  authProviders?: AuthProviderRegistry;
  audit?: LifecycleAudit;
  appAuthHandoff?: AppAuthHandoffCoordinator;
  monitoring?: AdminMonitoring;
  operations?: AdminOperationManager;
  catalog?: AppCatalog;
  imageBuilds?: ImageBuildManager;
  imageBuildExecutor?: ImageBuildExecutor;
  buildPackageStorage?: BuildPackageStorage;
  appImageUpdates?: AppImageUpdateCoordinator;
  resourceCleanup?: ResourceCleanupManager;
  activityTracker?: InstanceActivityMonitor;
  upgradeRollouts?: UpgradeRolloutService;
  upgradeRolloutWorker?: UpgradeRolloutWorker;
  /** 可替换的代码拥有插件集合；未提供时仅在显式兼容模式注册内置插件。 */
  pluginRegistry?: PlatformPluginRegistry;
  appPlugins?: readonly AppIntegrationPlugin[];
  tenantMembership?: TenantMembershipService;
  /** 可替换的代码拥有 Provider 集合；未提供时使用 Docker 兼容适配器。 */
  providerRegistry?: ExecutionProviderRegistry;
  /** 新 Workspace 的 Provider 选择；已有 Workspace 始终使用其持久化 pin。 */
  providerIdForApp?: (appId: string) => string | Promise<string>;
  /** 可选的 durable quota ledger；默认不启用以保持旧部署兼容。 */
  quotaAdmission?: QuotaAdmission;
  /** 外部 Adapter 的认证输入/错误翻译；省略时保留旧调用方兼容边界。 */
  providerAuthCompatibility?: ProviderAuthCompatibility;
  /** 组合根测试/启动器可注入环境；业务请求不能覆盖这些值。 */
  environment?: NodeJS.ProcessEnv;
  /** 显式覆盖环境中的兼容模式开关。 */
  compatibilityMode?: boolean;
  /**
   * 组合根是否必须从部署注入外部 Adapter。生产和 legacy 启动都应为 true；
   * 只有离线单元测试或明确的旧回切脚本才允许关闭。
   */
  requireExternalAdapter?: boolean;
  /**
   * 是否允许调用方提供的旧内置插件工厂作为最后回退。该开关不由部署环境
   * 自动打开，避免 Core 在没有 Adapter 时偷偷带入某个产品实现。
   */
  allowBuiltinCompatibility?: boolean;
  /** Portal 旧路由和管理投影的显式兼容边界。 */
  portalCompatibilityBoundary?: PortalCompatibilityBoundary;
  /** 兼容 facade 可显式提供旧插件；通用组合根不会设置此回调。 */
  compatibilityPluginFactory?: (input: {
    artifacts: OciArtifactManagementPort;
    config: PortalConfig;
    environment: NodeJS.ProcessEnv;
  }) => AppIntegrationPlugin;
  /** 可选的注册表构造选项；Provider 专属行为必须由 Provider 实例声明。 */
  authRegistryOptions?: AuthProviderRegistryOptions;
}

export interface ConfiguredAppPluginsOptions {
  readonly artifacts: OciArtifactManagementPort;
  readonly config?: PortalConfig;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * 组合根可显式锁定本次部署的 App 身份；未提供时读取部署环境。
   * 这是装载边界的身份断言，不允许请求或数据库覆盖。
   */
  readonly expectedAppId?: string;
  /** Adapter 槽位身份；当前发布模型要求它与 manifest id 一对一对应。 */
  readonly expectedAdapterId?: string;
  /** 仅兼容旧本地部署；生产组合根必须显式装载外部 Adapter。 */
  readonly allowBuiltinCompatibility?: boolean;
  /** 要求所有部署选择的 Adapter 成功加载。 */
  readonly requireExternalAdapter?: boolean;
  /** 可选的显式兼容插件工厂；通用 Core 不提供内置产品实现。 */
  readonly compatibilityPluginFactory?: PortalContextOptions["compatibilityPluginFactory"];
  /** 可替换的制品检查器和命令执行器，仅供迁移/测试组合注入。 */
  readonly releaseInspector?: AdapterReleaseInspector;
  readonly runCommand?: BuildCommandRunner;
  readonly scriptPath?: string;
}

export interface PortalContext {
  config: PortalConfig;
  /** 组合根是否允许遗留默认值和兼容路由。 */
  compatibilityMode: boolean;
  /** 旧 Portal 合同的显式防腐层；通用组合注入空实现。 */
  portalCompatibilityBoundary: PortalCompatibilityBoundary;
  /** Runtime profile selected from the loaded Adapter, when one is declared. */
  runtimeProfile?: RuntimeProfile;
  stores: PortalStores;
  providerId: string;
  artifacts: OciArtifactManagementPort;
  providerMetrics: ProviderMetricsPort;
  providerDiagnostics: ProviderDiagnosticsPort;
  providerHealth: ProviderHealthPort;
  accessTargetResolver: AccessTargetResolver;
  executionManager: WorkspaceExecutionManager;
  auth: AuthService;
  authProviders: AuthProviderRegistry;
  portalAuth: PortalAuth;
  lifecycle: InstanceLifecycle;
  forwarding: ForwardingPolicyManager;
  appAuthHandoff: AppAuthHandoffCoordinator;
  monitoring: AdminMonitoring;
  operations: AdminOperationManager;
  catalog: AppCatalog;
  imageBuilds: ImageBuildManager;
  imageBuildExecutor: ImageBuildExecutor;
  buildPackageStorage: BuildPackageStorage;
  appImageUpdates: AppImageUpdateCoordinator;
  resourceCleanup: ResourceCleanupManager;
  activityTracker: InstanceActivityMonitor;
  upgradeRollouts: UpgradeRolloutService;
  upgradeRolloutWorker: UpgradeRolloutWorker;
  plugins: PlatformPluginRegistry;
  tenantMembership: TenantMembershipService;
  providerRegistry: ExecutionProviderRegistry;
  quotaAdmission: QuotaAdmission | null;
}

/**
 * Loads deployment-selected adapters before the synchronous composition root
 * runs. Environment variables are deployment-owned; they are never read from
 * HTTP requests or durable catalog rows.
 */
export async function loadConfiguredAppPlugins(
  options: ConfiguredAppPluginsOptions,
): Promise<readonly AppIntegrationPlugin[]> {
  const environment = { ...(options.environment ?? process.env) };
  const config = options.config ?? loadGenericConfig(environment);
  if (config.controlPlaneOnly) {
    if (config.authProvider !== "none" || environment.OPENAPP_ADAPTER_CATALOG?.trim()
      || environment.OPENAPP_ADAPTER_MODULE?.trim()
      || readBooleanEnvironment(environment.OPENAPP_COMPATIBILITY_MODE, false)) {
      throw new ExternalAdapterError("control_plane_only_configuration_conflict");
    }
    return [];
  }
  if (environment.OPENAPP_ADAPTER_CATALOG?.trim()) {
    const { readAdapterCatalog } = await import("./adapter-catalog.js");
    const catalog = await readAdapterCatalog(environment.OPENAPP_ADAPTER_CATALOG.trim());
    const plugins: AppIntegrationPlugin[] = [];
    for (const entry of catalog.plugins) {
      const plugin = await loadExternalAppAdapter({
        moduleSpecifier: entry.module,
        artifacts: options.artifacts,
        environment: { ...environment, ...entry.environment, OPENAPP_APP_ID: entry.id, OPENAPP_ADAPTER_ID: entry.id },
        approvedModuleRoots: readOptionalListEnvironment(environment.OPENAPP_ADAPTER_ALLOWED_ROOTS),
        approvedPackageSpecifiers: readOptionalListEnvironment(environment.OPENAPP_ADAPTER_ALLOWED_PACKAGES),
        releaseInspector: options.releaseInspector,
        runCommand: options.runCommand,
        scriptPath: options.scriptPath,
      });
      assertConfiguredAdapterIdentity(plugin, entry.id, entry.id);
      if (plugin.manifest.version !== entry.version) throw new ExternalAdapterError("external_adapter_version_mismatch");
      plugins.push(plugin);
    }
    // Validate shared registrations before exposing a partially loaded catalog.
    new PlatformPluginRegistry(plugins);
    const expected = options.expectedAppId ?? environment.OPENAPP_APP_ID;
    if (expected && !plugins.some((plugin) => plugin.appId === expected)) {
      throw new ExternalAdapterError("external_adapter_default_app_missing");
    }
    return plugins;
  }
  const expectedAppId = normalizeConfiguredIdentity(
    options.expectedAppId ?? environment.OPENAPP_APP_ID,
    "OPENAPP_APP_ID",
  );
  const expectedAdapterId = normalizeConfiguredIdentity(
    options.expectedAdapterId ?? environment.OPENAPP_ADAPTER_ID,
    "OPENAPP_ADAPTER_ID",
  );
  if (expectedAppId && expectedAdapterId && expectedAppId !== expectedAdapterId) {
    throw new ExternalAdapterError("external_adapter_identity_configuration_mismatch");
  }
  const moduleSpecifiers = (environment.OPENAPP_ADAPTER_MODULE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const allowBuiltinCompatibility = options.allowBuiltinCompatibility
    ?? readBooleanEnvironment(environment.OPENAPP_COMPATIBILITY_MODE, false);
  const required = options.requireExternalAdapter
    ?? readBooleanEnvironment(environment.OPENAPP_ADAPTER_REQUIRED, true);
  if (required && moduleSpecifiers.length === 0) {
    throw new ExternalAdapterError("external_adapter_module_required");
  }
  // 先装载外部 Adapter，再决定是否启用内置回切。这样生产组合不会先构造
  // 一份产品实现再被外部模块覆盖；同一个 App 的实现来源始终唯一可追踪。
  const plugins: AppIntegrationPlugin[] = [];
  const approvedModuleRoots = readOptionalListEnvironment(environment.OPENAPP_ADAPTER_ALLOWED_ROOTS);
  const approvedPackageSpecifiers = readOptionalListEnvironment(environment.OPENAPP_ADAPTER_ALLOWED_PACKAGES);
  const loadedIds = new Set<string>();
  for (const moduleSpecifier of moduleSpecifiers) {
    try {
      const plugin = await loadExternalAppAdapter({
        moduleSpecifier,
        artifacts: options.artifacts,
        environment,
        ...(options.releaseInspector === undefined ? {} : { releaseInspector: options.releaseInspector }),
        ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
        ...(options.scriptPath === undefined ? {} : { scriptPath: options.scriptPath }),
        ...(approvedModuleRoots === undefined ? {} : { approvedModuleRoots }),
        ...(approvedPackageSpecifiers === undefined ? {} : { approvedPackageSpecifiers }),
      });
      assertConfiguredAdapterIdentity(plugin, expectedAppId, expectedAdapterId);
      if (loadedIds.has(plugin.appId)) throw new ExternalAdapterError("external_adapter_duplicate_app");
      loadedIds.add(plugin.appId);
      plugins.push(plugin);
    } catch (error) {
      if (isFatalAdapterConfigurationError(error)) throw error;
      if (required) throw error;
      const code = error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : "external_adapter_load_failed";
      console.warn(`[OpenApp adapter] ${moduleSpecifier} unavailable (${code}); continuing with configured plugins`);
    }
  }
  // 内置实现只能作为整个外部装载失败后的最后回退。即使 App id 不同，也不
  // 应在已有外部组合时构造一份隐式产品实现，否则生产进程仍会携带未使用的
  // 兼容代码和副作用；需要多 App 时应通过多个外部 Adapter 明确注册。
  const builtinEnabled = plugins.length === 0
    && allowBuiltinCompatibility
    && !required
    && options.compatibilityPluginFactory !== undefined;
  if (builtinEnabled) {
    const builtin = options.compatibilityPluginFactory!({
      artifacts: options.artifacts,
      config,
      environment,
    });
    assertConfiguredAdapterIdentity(builtin, expectedAppId, expectedAdapterId);
    const normalizedBuiltinId = builtin.appId.trim().toLowerCase();
    if (!loadedIds.has(normalizedBuiltinId)) {
      plugins.push(builtin);
    }
  }
  if (plugins.length === 0) throw new ExternalAdapterError("external_adapter_no_plugins");
  return plugins;
}

function normalizeConfiguredIdentity(value: string | undefined, name: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new ExternalAdapterError("external_adapter_identity_invalid", {
      cause: new Error(`${name} is invalid`),
    });
  }
  return normalized;
}

function assertConfiguredAdapterIdentity(
  plugin: AppIntegrationPlugin,
  expectedAppId: string | undefined,
  expectedAdapterId: string | undefined,
): void {
  const actual = plugin.appId.trim().toLowerCase();
  if (expectedAppId && actual !== expectedAppId) {
    throw new ExternalAdapterError("external_adapter_app_identity_mismatch");
  }
  if (expectedAdapterId && actual !== expectedAdapterId) {
    throw new ExternalAdapterError("external_adapter_adapter_identity_mismatch");
  }
}

function isFatalAdapterConfigurationError(error: unknown): boolean {
  if (!(error instanceof ExternalAdapterError)) return false;
  return [
    "external_adapter_identity_configuration_mismatch",
    "external_adapter_identity_invalid",
    "external_adapter_app_identity_mismatch",
    "external_adapter_adapter_identity_mismatch",
  ].includes(error.code);
}

/** Async production composition root; the legacy synchronous API remains test-compatible. */
export async function createPortalContextAsync(options: PortalContextOptions = {}): Promise<PortalContext> {
  if (options.pluginRegistry || options.appPlugins) {
    return createPortalContext({
      ...options,
      // 异步入口代表部署组合根；提供插件时默认走通用模式，旧调用方可显式
      // 传 compatibilityMode:true 保留同步兼容语义。
      compatibilityMode: options.compatibilityMode ?? false,
    });
  }
  const environment = options.environment ?? process.env;
  const compatibilityMode = options.compatibilityMode
    ?? readBooleanEnvironment(environment.OPENAPP_COMPATIBILITY_MODE, false);
  const config = options.config ?? loadGenericConfig(environment);
  let runtime = options.runtime ?? createContainerRuntime({
    compatibilityMode,
    environment,
    // 插件尚未加载时只能使用中性 profile；完成插件组合后会替换为
    // Adapter 声明的 profile，避免兼容模式在发现阶段提前读取产品变量。
    ...(compatibilityMode ? { profile: GENERIC_RUNTIME_PROFILE } : {}),
  });
  let artifacts = options.artifacts ?? new DockerArtifactAdapter(runtime);
  const artifactDelegate = !options.runtime && !options.artifacts
    ? createArtifactDelegate(artifacts)
    : undefined;
  const pluginArtifacts = artifactDelegate?.port ?? artifacts;
  const appPlugins = await loadConfiguredAppPlugins({
    artifacts: pluginArtifacts,
    config,
    allowBuiltinCompatibility: options.allowBuiltinCompatibility ?? false,
    requireExternalAdapter: options.requireExternalAdapter
      ?? readBooleanEnvironment(environment.OPENAPP_ADAPTER_REQUIRED, true),
    environment,
  });
  const pluginRegistry = new PlatformPluginRegistry(appPlugins, { allowEmpty: config.controlPlaneOnly === true });
  const runtimeProfiles = pluginRegistry.runtimeProfiles();
  if (runtimeProfiles.length > 1) {
    throw new Error("platform_plugin_runtime_profile_selection_required");
  }
  const runtimeProfile = runtimeProfiles[0];
  if (!options.runtime && !options.artifacts && runtimeProfile) {
    runtime = createContainerRuntime({ compatibilityMode, environment, profile: runtimeProfile });
    artifacts = new DockerArtifactAdapter(runtime);
    artifactDelegate?.set(artifacts);
  }
  const authProviderId = resolveCompositionAuthProvider(config, appPlugins, environment);
  const selectedConfig = authProviderId === config.authProvider
    ? config
    : { ...config, authMode: authProviderId, authProvider: authProviderId };
  const provisioningPolicyDefaults = pluginRegistry.provisioningPolicyDefaults();
  const stores = options.stores ?? createGenericPortalStores(createConfiguredPersistence(selectedConfig, {
    legacyCompatibility: compatibilityMode,
    compatibilityDefaults: {
      authProvider: authProviderId,
      ...(typeof provisioningPolicyDefaults.defaultAppId === "string"
        ? { appId: provisioningPolicyDefaults.defaultAppId }
        : {}),
    },
    strategyDefinitions: pluginRegistry.buildStrategyDefinitions(),
    provisioningPolicyDefaults,
  }));
  return createPortalContext({
    ...options,
    config: selectedConfig,
    stores,
    runtime,
    artifacts,
    appPlugins,
    pluginRegistry,
    compatibilityMode,
    providerAuthCompatibility: genericProviderAuthCompatibility,
  });
}

/**
 * Generic deployments may omit AUTH_PROVIDER when their single Adapter declares
 * one Provider. Multiple Provider plugins require an explicit deployment choice;
 * a no-auth App remains on the neutral `none` service.
 */
export function resolveCompositionAuthProvider(
  config: PortalConfig,
  plugins: readonly AppIntegrationPlugin[],
  environment: NodeJS.ProcessEnv,
): string {
  if (environment.AUTH_PROVIDER?.trim()) return config.authProvider;
  if (config.authProvider !== "none") return config.authProvider;
  const providerIds = [...new Set(plugins.flatMap((plugin) => plugin.authProviders?.map((provider) => provider.id.trim().toLowerCase()) ?? []))];
  if (providerIds.length <= 1) return providerIds[0] ?? "none";
  throw new ExternalAdapterError("auth_provider_selection_required");
}

export function createPortalContext(options: PortalContextOptions = {}): PortalContext {
  const compatibilityMode = options.compatibilityMode ?? false;
  const environment = options.environment ?? process.env;
  const config = options.config ?? loadGenericConfig(environment);
  let runtime = options.runtime ?? createContainerRuntime({
    compatibilityMode,
    environment,
    ...(compatibilityMode ? { profile: GENERIC_RUNTIME_PROFILE } : {}),
  });
  let artifacts = options.artifacts ?? new DockerArtifactAdapter(runtime);
  // Adapter build strategies are created before the final profile is selected.
  // A tiny delegating port lets us replace the bootstrap Runtime without
  // retaining an artifact adapter bound to the wrong mount/health contract.
  const artifactDelegate = !options.runtime && !options.artifacts
    ? createArtifactDelegate(artifacts)
    : undefined;
  const pluginArtifacts = artifactDelegate?.port ?? artifacts;
  const plugins = options.pluginRegistry ?? new PlatformPluginRegistry(
    options.appPlugins ?? (compatibilityMode && options.compatibilityPluginFactory
      ? [options.compatibilityPluginFactory({ artifacts: pluginArtifacts, config, environment })]
      : []),
  );
  const runtimeProfiles = plugins.runtimeProfiles();
  if (runtimeProfiles.length > 1) {
    throw new Error("platform_plugin_runtime_profile_selection_required");
  }
  const runtimeProfile = runtimeProfiles[0];
  if (!options.runtime && !options.artifacts && runtimeProfile) {
    runtime = createContainerRuntime({ compatibilityMode, environment, profile: runtimeProfile });
    artifacts = new DockerArtifactAdapter(runtime);
    artifactDelegate?.set(artifacts);
  }
  const stores = options.stores ?? createGenericPortalStores(createConfiguredPersistence(config, {
    legacyCompatibility: compatibilityMode,
    compatibilityDefaults: {
      authProvider: config.authProvider,
      ...(typeof plugins.provisioningPolicyDefaults().defaultAppId === "string"
        ? { appId: plugins.provisioningPolicyDefaults().defaultAppId }
        : {}),
    },
    strategyDefinitions: plugins.buildStrategyDefinitions(),
    provisioningPolicyDefaults: plugins.provisioningPolicyDefaults(),
  }));
  const portalCompatibilityBoundary = options.portalCompatibilityBoundary
    ?? resolvePortalCompatibilityBoundary(plugins, compatibilityMode);
  // 先完成插件组合，再把其声明的合同注入 Provider；这样通用部署不会
  // 因 Provider 适配器的历史默认值而接受未安装的产品工作负载。
  const baseExecutionProvider = options.executionProvider ?? new DockerProviderAdapter(runtime, {
    metrics: true,
    compatibilityMode,
    supportedExecutionContracts: plugins.executionContracts(),
  });
  const providerRegistry = options.providerRegistry ?? new ExecutionProviderRegistry([
    adaptExecutionProvider(baseExecutionProvider as ExecutionProviderAdapterInput),
  ]);
  const executionProvider = providerRegistry.router({
    defaultProviderId: providerRegistry.defaultProviderId,
    resolveProviderId: async (workspaceId) => (
      (await stores.instances.getWorkspaceExecutionProjection(workspaceId))?.execution.providerId
    ),
  });
  let authProviders = options.authProviders ?? plugins.createAuthProviderRegistry({
    allowEmpty: true,
    ...(options.authRegistryOptions ?? {}),
  });
  const configuredPluginAuth = authProviders.service(config.authProvider);
  const auth = options.auth
    ?? configuredPluginAuth
    ?? (config.authProvider === "none"
      ? createGenericAuthService(config)
      : (() => { throw new Error("auth_provider_not_registered"); })());
  if (options.auth) {
    // 注入 Provider 必须覆盖同 id 的组合根实现，但保留其他平台 Provider，
    // 这样测试替身和灰度 Provider 不会意外请求真实身份服务。
    // 替身经常只实现行为而省略展示元数据；注册表仍沿用已审核 Provider
    // 的 presentation，但不改变注入服务对象或其认证语义。
    const registeredPresentation = auth.presentation === undefined
      ? authProviders.service(auth.provider)?.presentation
      : undefined;
    const registeredAuth = registeredPresentation === undefined
      ? auth
      : { ...auth, presentation: cloneAuthPresentation(registeredPresentation) };
    const remaining = authProviders.providerIds()
      .filter((providerId) => providerId !== auth.provider)
      .map((providerId) => authProviders.service(providerId)!)
      .filter(Boolean);
    authProviders = new AuthProviderRegistry([registeredAuth, ...remaining], {
      allowEmpty: auth.provider === "none",
    });
  } else if (!authProviders.has(auth.provider)) {
    authProviders = new AuthProviderRegistry([auth, ...authProviders.providerIds()
      .map((providerId) => authProviders.service(providerId)!)], {
      allowEmpty: auth.provider === "none",
    });
  }
  const tenantMembership = options.tenantMembership ?? new TenantMembershipService(stores.tenants);
  const providerMetrics = options.providerMetrics ?? executionProvider;
  const providerDiagnostics = options.providerDiagnostics ?? executionProvider;
  const providerHealth = options.providerHealth ?? executionProvider;
  const accessTargetResolver = options.accessTargetResolver ?? executionProvider;
  const activityTracker = options.activityTracker ?? new InstanceActivityTracker({
    store: stores.activity,
    onHeartbeatError: (error) => console.error("instance activity heartbeat failed", error),
  });
  const upgradeAdmission = new InstanceUpgradeAdmission({
    store: stores.activity,
    tracker: activityTracker,
  });
  const executionManager = options.executionManager ?? new WorkspaceExecutionManager({
    store: stores.instances,
    provider: executionProvider,
    storageBindingResolver: executionProvider,
    storageReleaser: executionProvider,
    deletionDrain: {
      begin: (workspaceId, transactionId, signal) => {
        signal?.throwIfAborted();
        return upgradeAdmission.begin(
          workspaceId,
          `workspace-deletion:${workspaceId}`,
          transactionId,
          "force",
        );
      },
      clear: (workspaceId, transactionId) => upgradeAdmission.clear(
        workspaceId,
        `workspace-deletion:${workspaceId}`,
        transactionId,
      ),
    },
    transactions: executionProvider,
  });
  const managedLifecycleRuntime = new WorkspaceExecutionRuntimeBridge({
    manager: executionManager,
    metrics: providerMetrics,
    // 默认 App 由策略提供；旧调用方省略 appId 时，桥接层不再自行决定具体 App。
    defaultAppId: async () => (await stores.instances.getProvisioningPolicy()).defaultAppId,
    launchProfileFor: async (imageReference) => toLaunchProfile(
      await stores.instances.getProvisioningPolicy(),
      imageReference,
    ),
  });
  const lifecycleRuntime = options.useLegacyLifecycleRuntime ? runtime : managedLifecycleRuntime;
  const portalAuth = new PortalAuth(
    auth.provider,
    auth,
    stores.identity,
    config,
    undefined,
    authProviders,
    options.providerAuthCompatibility
      ?? genericProviderAuthCompatibility,
  );
  const appAuthHandoff = options.appAuthHandoff ?? new AppAuthHandoffCoordinator(
    new AppAuthHandoffRegistry({
      portalCookieName: config.cookieName,
      handoffs: plugins.appAuthHandoffs(),
    }),
    {
      resolveAppId: async (userId) => {
        const existing = await stores.instances.getContainerForUser(userId);
        if (existing) return existing.appId;
        return (await stores.instances.getProvisioningPolicy()).defaultAppId;
      },
      resolveNoAuthApp: async (appId) => {
        const app = await stores.catalog.getApp(appId);
        return app?.authAdapterId === "none";
      },
    },
  );
  const catalog = options.catalog ?? new AppCatalog({
    store: stores.catalog,
    releaseRoot: config.releaseDir,
    bootstrap: plugins.list().find((plugin) => plugin.catalogBootstrap)?.catalogBootstrap ?? null,
    runtimeContractForApp: (appId, version) => (
      plugins.get(appId)?.catalogBootstrap?.legacyVersion.runtimeContract
        ?? plugins.get(appId)?.manifest.executionContracts?.[0]
        ?? version.runtimeContract
    ),
    supportsAuthAdapter: (appId) => appAuthHandoff.supportsCredentialedApp(appId),
    releaseInspectorForApp: (appId) => plugins.releaseInspectorForApp(appId),
    resolveImage: artifacts.resolveImage.bind(artifacts),
    validateImage: artifacts.validateImage.bind(artifacts),
    validateCandidateImage: artifacts.validateBuiltImage.bind(artifacts),
    withActivationLock: (operation) => stores.admin.withReleaseActivationLock(operation),
    registerNoAuthApp: (appId) => appAuthHandoff.registerNoAuthApp(appId),
  });
  const forwarding = new ForwardingPolicyManager(stores.admin, {
    publicBaseUrl: config.publicBaseUrl,
    allowedOrigins: config.allowedOrigins,
  });
  const lifecycle = new InstanceLifecycle({
    runtime: lifecycleRuntime,
    store: {
      ...stores.instances,
      listContainers: () => stores.instances.listContainers(),
      updateContainer: options.useLegacyLifecycleRuntime
        ? (container) => stores.instances.updateContainer(container)
        : (container) => executionManager.persistLegacyContainer(container),
      getLaunchTarget: (appId) => catalog.launchTarget(appId),
    },
    audit: options.audit ?? stores.admin.recordAudit,
    withContainerMaintenance: (instanceId, operation) => stores.admin.withMaintenanceLease(
      upgradeInstanceLeaseName(instanceId),
      async (signal) => {
        signal.throwIfAborted();
        if (await stores.activity.isInstanceDraining(instanceId, new Date().toISOString())) return null;
        signal.throwIfAborted();
        return operation(signal);
      },
    ),
    ...(options.useLegacyLifecycleRuntime ? {} : {
      deleteWorkspace: async (workspaceId, signal) => {
        const projection = await executionManager.deleteWorkspace({ workspaceId, signal });
        return { ownerId: projection.workspace.ownerId };
      },
    }),
    providerIdForApp: options.providerIdForApp ?? (() => providerRegistry.defaultProviderId),
    ...(options.quotaAdmission ? { quotaAdmission: options.quotaAdmission } : {}),
  });
  const monitoring = options.monitoring ?? new AdminMonitoring({
    admin: stores.admin,
    metrics: providerMetrics,
    health: providerHealth,
    providerId: executionProvider.providerId,
    healthProviders: providerRegistry.list().map((provider) => ({
      providerId: provider.providerId,
      health: executionProvider,
    })),
    forwarding: () => forwarding.get(),
  });
  const operations = options.operations ?? new AdminOperationManager(operationStoreFromAdmin(stores.admin));
  const strategyRegistry = options.imageBuilds?.strategyRegistry ?? new BuildStrategyRegistry([
    ...plugins.buildStrategyAdapters(),
  ]);
  const imageBuilds = options.imageBuilds ?? new ImageBuildManager({
    store: stores.builds,
    strategyRegistry,
    initialStrategies: plugins.buildStrategyDefinitions(),
  });
  const imageBuildExecutor = options.imageBuildExecutor ?? new ImageBuildExecutor({
    manager: imageBuilds,
    releaseRoot: config.releaseDir,
    resolveVersion: (id) => stores.catalog.getAppVersion(id),
  });
  const buildPackageStorage = options.buildPackageStorage ?? new BuildPackageStorage({
    releaseRoot: config.releaseDir,
    store: stores.builds,
  });
  const appImageUpdates = options.appImageUpdates ?? new AppImageUpdateCoordinator({
    catalog,
    imageBuilds,
    imageBuildExecutor,
    buildPackageStorage,
    defaultStrategyIdForApp: (appId) => plugins.defaultBuildStrategyId(appId),
    supportsStrategyForApp: (appId, strategyId) => plugins.supportsBuildStrategy(appId, strategyId),
  });
  const resourceCleanup = options.resourceCleanup ?? new ResourceCleanupManager({
    catalog: stores.catalog,
    builds: stores.builds,
    instances: stores.instances,
    rollouts: stores.upgrades,
    artifacts,
    releaseRoot: config.releaseDir,
  });
  const upgradeRollouts = options.upgradeRollouts ?? new UpgradeRolloutService({
    store: stores.upgrades,
    source: {
      getContainer: (id) => stores.instances.getContainer(id),
      getLaunchTarget: (appId) => catalog.launchTarget(appId),
      getProvisioningPolicy: () => stores.instances.getProvisioningPolicy(),
    },
    idempotencyConflicts: async (actorUserId, idempotencyKey) => Boolean(
      await stores.admin.findOperationByIdempotencyKey(actorUserId, idempotencyKey)
    ),
  });
  const upgradeRolloutWorker = options.upgradeRolloutWorker ?? new UpgradeRolloutWorker({
    store: stores.upgrades,
    source: { getContainer: (id) => stores.instances.getContainer(id) },
    activity: new InstanceUpgradeActivityPolicy({
      store: stores.activity,
      metrics: providerMetrics,
    }),
    admission: upgradeAdmission,
    executor: {
      acceptDeferredCandidate: async (item, signal) => {
        if (options.useLegacyLifecycleRuntime) {
          if (!runtime.acceptDeferredCandidate) return false;
          const result = await runtime.acceptDeferredCandidate(item.instanceId, item.userId, signal);
          return result !== "not_found";
        }
        const result = await executionManager.acceptDeferredExecution(item.instanceId, item.userId, signal);
        return result !== "not_found";
      },
      rebuild: async (item, actorUserId, signal) => {
        if (!item.attemptId) throw new Error("upgrade_rollout_attempt_missing");
        await lifecycle.rebuild(item.instanceId, actorUserId, {
          target: {
            appVersionId: item.targetAppVersionId,
            imageArtifactId: item.targetImageArtifactId,
            imageReference: item.targetImageReference,
            executionContract: item.targetRuntimeContract,
            launchProfile: item.launchProfile,
          },
          targetState: item.desiredState,
          rebuildTransactionId: item.attemptId,
          signal,
          maintenanceLeaseHeld: true,
        });
      },
      inspectRebuild: async (item, signal) => {
        if (!item.attemptId) return null;
        signal.throwIfAborted();
        if (options.useLegacyLifecycleRuntime) {
          if (!runtime.inspectRebuildTransaction) return null;
          let legacyInspection = await runtime.inspectRebuildTransaction(item.instanceId, item.attemptId, signal);
          signal.throwIfAborted();
          if (legacyInspection.instance) {
            await lifecycle.sync(item.instanceId, { maintenanceLeaseHeld: true, signal });
            signal.throwIfAborted();
            legacyInspection = await runtime.inspectRebuildTransaction(item.instanceId, item.attemptId, signal);
          }
          return { status: legacyInspection.status };
        }
        let inspection = await executionManager.inspectTransaction(item.instanceId, item.attemptId, signal);
        if (!inspection) return null;
        signal.throwIfAborted();
        if (inspection.execution) {
          await lifecycle.sync(item.instanceId, { maintenanceLeaseHeld: true, signal });
          signal.throwIfAborted();
          // sync 会提交健康候选或回滚失败候选；再次只读检查，避免 Worker
          // 使用恢复前的 pending 结论把已回滚事务误判为永久不一致。
          inspection = await executionManager.inspectTransaction(item.instanceId, item.attemptId, signal);
          if (!inspection) return null;
        }
        signal.throwIfAborted();
        return { status: inspection.status };
      },
      diagnose: async (item, signal) => {
        return providerDiagnostics.readDiagnostics(item.instanceId, signal);
      },
    },
    withLease: (operation) => stores.admin.withMaintenanceLease("upgrade-rollout-worker", operation),
    withItemLease: (instanceId, operation) => stores.admin.withMaintenanceLease(upgradeInstanceLeaseName(instanceId), operation),
  });
  return {
    config,
    compatibilityMode,
    portalCompatibilityBoundary,
    ...(runtimeProfile ? { runtimeProfile } : {}),
    stores,
    providerId: executionProvider.providerId,
    artifacts,
    providerMetrics,
    providerDiagnostics,
    providerHealth,
    accessTargetResolver,
    executionManager,
    auth,
    authProviders,
    portalAuth,
    lifecycle,
    forwarding,
    appAuthHandoff,
    monitoring,
    operations,
    catalog,
    imageBuilds,
    imageBuildExecutor,
    buildPackageStorage,
    appImageUpdates,
    resourceCleanup,
    activityTracker,
    upgradeRollouts,
    upgradeRolloutWorker,
    plugins,
    tenantMembership,
    providerRegistry,
    quotaAdmission: options.quotaAdmission ?? null,
  };
}

/**
 * 兼容模式只为部署选中的默认 App 构造一个 Adapter-owned Host。普通模式和
 * 没有 legacy 声明的旧插件继续使用空边界，避免把产品实现带入 generic 图。
 */
function resolvePortalCompatibilityBoundary(
  plugins: PlatformPluginRegistry,
  compatibilityMode: boolean,
): PortalCompatibilityBoundary {
  if (!compatibilityMode) return GENERIC_PORTAL_COMPATIBILITY_BOUNDARY;
  const defaults = plugins.provisioningPolicyDefaults();
  const appId = defaults.defaultAppId
    ?? (plugins.list().length === 1 ? plugins.list()[0]?.appId : undefined);
  if (!appId) return GENERIC_PORTAL_COMPATIBILITY_BOUNDARY;
  const legacy = plugins.legacyForApp(appId);
  if (!legacy) return GENERIC_PORTAL_COMPATIBILITY_BOUNDARY;
  const compatibility = plugins.compatibilityForApp(appId);
  return createLegacyPortalCompatibilityBoundary(legacy, {
    runtimeImageEnvironmentKeys: compatibility?.legacyAliases?.environmentKeys,
  });
}

function readBooleanEnvironment(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new ExternalAdapterError("external_adapter_boolean_environment_invalid");
}

function cloneAuthPresentation(
  presentation: NonNullable<AuthService["presentation"]>,
): NonNullable<AuthService["presentation"]> {
  return {
    ...presentation,
    ...(presentation.fields ? { fields: presentation.fields.map((field) => ({ ...field })) } : {}),
    ...(presentation.capabilities ? { capabilities: { ...presentation.capabilities } } : {}),
  };
}

/** 解析部署提供的适配器 allowlist；空值表示沿用旧版的未限制行为。 */
function readOptionalListEnvironment(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length > 64 || items.some((item) => item.length > 512 || /[\0\r\n]/u.test(item))) {
    throw new ExternalAdapterError("external_adapter_allowlist_invalid");
  }
  return [...new Set(items)];
}

function createArtifactDelegate(initial: OciArtifactManagementPort): {
  port: OciArtifactManagementPort;
  set(next: OciArtifactManagementPort): void;
} {
  let current = initial;
  return {
    port: {
      listImages: () => current.listImages(),
      resolveImage: (reference) => current.resolveImage(reference),
      validateImage: (reference, contract) => current.validateImage(reference, contract),
      validateBuiltImage: (reference, contract) => current.validateBuiltImage(reference, contract),
      removeImageIfCurrent: (reference, imageId) => current.removeImageIfCurrent(reference, imageId),
      pullImage: (reference) => current.pullImage(reference),
      loadImage: (archivePath, reference) => current.loadImage(archivePath, reference),
    },
    set(next) {
      current = next;
    },
  };
}
