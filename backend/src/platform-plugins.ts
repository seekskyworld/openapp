import { APP_ID_PATTERN } from "./app-id.js";
import type { AppAuthHandoff } from "./auth/app-auth-handoff.js";
import type { AppCatalogBootstrap } from "./app-catalog.js";
import type { BuildStrategyAdapter } from "./build-strategies.js";
import type { BuildStrategy } from "./models.js";
import { AuthProviderRegistry } from "./auth/provider-registry.js";
import type { AuthProviderRegistryOptions } from "./auth/provider-registry.js";
import type { AuthService } from "./auth/types.js";
import type { AuthProviderField } from "./auth/types.js";
import type { ProvisioningPolicyDefaults } from "./instance-policy.js";
import { GENERIC_RUNTIME_CONTRACT, NO_RUNTIME_CONTRACT } from "./runtime-contracts.js";
import { validateRuntimeProfile, type RuntimeProfile } from "./runtime.js";
import {
  validateAdapterCompatibility,
  validateAdapterLegacy,
  type AdapterCompatibility,
  type AdapterLegacyIntegration,
  type AdapterErrorCatalog,
  type AdapterMigrationPlan,
} from "@openapp/contracts";

/**
 * 平台插件的稳定描述。数据库只保存这些描述引用的 id，实际行为必须来自
 * 服务端启动时注册的代码，避免请求或数据库配置执行任意服务器代码。
 */
export interface PlatformPluginManifest {
  readonly id: string;
  readonly apiVersion: string;
  readonly version: string;
  readonly authProviders: readonly string[];
  readonly appIntegrations: readonly string[];
  readonly buildStrategies: readonly string[];
  /**
   * 插件实际需要的工作负载合同。Core 只把它用于 Provider 能力协商，
   * 不会根据 App id 猜测合同；省略时仅保留中性的通用/无运行时合同。
   */
  readonly executionContracts?: readonly string[];
  readonly entryExperience?: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
}

/** 用户入口所需的品牌和字段元数据；状态机仍由 Core 所有。 */
export interface EntryExperienceManifest {
  readonly id: string;
  readonly label: string;
  readonly logoUrl: string;
  /** Core 当前可渲染 email-code；none 用于明确无认证入口。 */
  readonly challenge: "email_code" | "none";
  readonly defaultWorkspace: "personal";
  /** Optional adapter-owned fields rendered by the generic entry shell. */
  readonly fields?: readonly AuthProviderField[];
}

/**
 * 解析后的用户入口合同。它只包含浏览器需要的安全元数据；工作区状态机、
 * 授权和实例生命周期仍由 Core 负责，插件不能借此注入可执行逻辑。
 */
export interface WorkspaceEntryManifest {
  readonly appId: string;
  readonly appName: string;
  /** 旧入口兼容投影；通用组合根为 false/省略。 */
  readonly compatibilityMode?: boolean;
  /** 登录页应选择的平台注册 Provider；未声明时由前端使用平台默认项。 */
  readonly authProviderId?: string;
  readonly entry: EntryExperienceManifest;
  readonly capabilities: Readonly<Record<string, boolean>>;
  /** 适配器提供的安全错误文案；别名和迁移证据不会下发到浏览器。 */
  readonly errorCatalog?: AdapterErrorCatalog;
}

/** 由服务器代码拥有的身份 Provider；数据库和请求只能引用它的稳定 id。 */
export interface AuthProviderPlugin {
  readonly id: string;
  /** 平台级 Provider 可被多个 App 引用；默认 Provider 仍按 App 唯一校验。 */
  readonly scope?: "app" | "platform";
  create(): AuthService;
}

/**
 * 一个 App 的可替换集成边界。认证、构建和入口都是可选能力；普通无认证
 * 单体项目只需要 manifest 和工作负载/制品配置，不必实现产品专用 handoff。
 */
export interface AppIntegrationPlugin {
  readonly appId: string;
  readonly manifest: PlatformPluginManifest;
  /** 可选的首次目录引导；Core 不为没有该能力的 App 猜测镜像或版本。 */
  readonly catalogBootstrap?: AppCatalogBootstrap;
  readonly authHandoff?: AppAuthHandoff;
  readonly authProviders?: readonly AuthProviderPlugin[];
  readonly buildStrategies?: readonly BuildStrategyAdapter[];
  /** Durable definitions paired with the code-owned build adapters. */
  readonly strategyDefinitions?: readonly BuildStrategy[];
  /** 仅在持久化策略表为空时应用的默认值。 */
  readonly provisioningPolicyDefaults?: ProvisioningPolicyDefaults;
  readonly entryExperience?: EntryExperienceManifest;
  /** Provider-neutral runtime shape supplied by the reviewed App Adapter. */
  readonly runtimeProfile?: RuntimeProfile;
  /** Adapter-owned release metadata compatibility; absent for generic packages. */
  readonly releaseInspector?: import('@openapp/contracts').AdapterReleaseInspector;
  /** Adapter-owned legacy aliases, diagnostics and migration evidence. */
  readonly compatibility?: AdapterCompatibility;
  /** Adapter-owned runtime compatibility island; absent for ordinary Apps. */
  readonly legacy?: AdapterLegacyIntegration;
}

export class PlatformPluginRegistryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/**
 * 进程启动时构造的不可变插件注册表。它只负责组合和能力查询，不参与
 * Workspace 生命周期或授权决策，确保 Core 与具体 App 实现保持单向依赖。
 */
export class PlatformPluginRegistry {
  readonly #apps: ReadonlyMap<string, AppIntegrationPlugin>;
  readonly #manifests: readonly PlatformPluginManifest[];
  readonly #handoffs: readonly AppAuthHandoff[];
  readonly #authProviders: ReadonlyMap<string, AuthProviderPlugin>;
  readonly #buildStrategies: readonly BuildStrategyAdapter[];
  readonly #strategyDefinitions: readonly BuildStrategy[];
  readonly #provisioningPolicyDefaults: ProvisioningPolicyDefaults;
  readonly #executionContracts: readonly string[];
  readonly #runtimeProfiles: ReadonlyMap<string, RuntimeProfile>;
  readonly #compatibilities: ReadonlyMap<string, AdapterCompatibility>;
  readonly #legacies: ReadonlyMap<string, AdapterLegacyIntegration>;

  constructor(plugins: readonly AppIntegrationPlugin[], options: { allowEmpty?: boolean } = {}) {
    if (plugins.length === 0 && !options.allowEmpty) throw new PlatformPluginRegistryError("platform_plugin_required");
    const apps = new Map<string, AppIntegrationPlugin>();
    const manifests = new Map<string, PlatformPluginManifest>();
    const handoffs = new Map<string, AppAuthHandoff>();
    const authProviders = new Map<string, AuthProviderPlugin>();
    const strategies = new Map<string, BuildStrategyAdapter>();
    const definitions = new Map<string, BuildStrategy>();
    const executionContracts = new Set<string>();
    const runtimeProfiles = new Map<string, RuntimeProfile>();
    const compatibilities = new Map<string, AdapterCompatibility>();
    const legacies = new Map<string, AdapterLegacyIntegration>();
    const migrationPlans = new Map<string, string>();
    let provisioningPolicyDefaults: ProvisioningPolicyDefaults = {};

    for (const plugin of plugins) {
      const appId = normalizeId(plugin.appId, "platform_plugin_invalid_app_id");
      const manifest = validateManifest(plugin.manifest, appId);
      for (const contract of manifest.executionContracts ?? []) executionContracts.add(contract);
      if (apps.has(appId) || manifests.has(manifest.id)) {
        throw new PlatformPluginRegistryError("platform_plugin_duplicate_id");
      }
      if (!manifest.appIntegrations.includes(appId)) {
        throw new PlatformPluginRegistryError("platform_plugin_manifest_app_mismatch");
      }
      if (plugin.authHandoff) {
        if (plugin.authHandoff.appId !== appId) {
          throw new PlatformPluginRegistryError("platform_plugin_handoff_app_mismatch");
        }
        if (!manifest.appIntegrations.includes(plugin.authHandoff.appId)) {
          throw new PlatformPluginRegistryError("platform_plugin_manifest_handoff_mismatch");
        }
        if (handoffs.has(appId)) throw new PlatformPluginRegistryError("platform_plugin_duplicate_handoff");
        handoffs.set(appId, plugin.authHandoff);
      }
      for (const provider of plugin.authProviders ?? []) {
        const providerId = normalizeId(provider.id, "platform_plugin_invalid_auth_provider");
        if (authProviders.has(providerId)) {
          const existing = authProviders.get(providerId)!;
          const shared = existing.scope === "platform" && provider.scope === "platform";
          if (!shared) {
            throw new PlatformPluginRegistryError("platform_plugin_duplicate_auth_provider");
          }
          if (!manifest.authProviders.includes(providerId)) {
            throw new PlatformPluginRegistryError("platform_plugin_manifest_auth_provider_mismatch");
          }
          continue;
        }
        authProviders.set(providerId, provider);
        if (!manifest.authProviders.includes(providerId)) {
          throw new PlatformPluginRegistryError("platform_plugin_manifest_auth_provider_mismatch");
        }
      }
      for (const strategy of plugin.buildStrategies ?? []) {
        const key = strategyKey(strategy.id, strategy.revision);
        if (strategies.has(key)) throw new PlatformPluginRegistryError("platform_plugin_duplicate_build_strategy");
        if (!manifest.buildStrategies.includes(strategy.id)) {
          throw new PlatformPluginRegistryError("platform_plugin_manifest_build_strategy_mismatch");
        }
        strategies.set(key, strategy);
      }
      for (const definition of plugin.strategyDefinitions ?? []) {
        const key = strategyKey(definition.id, definition.revision);
        if (definitions.has(key)) throw new PlatformPluginRegistryError("platform_plugin_duplicate_build_strategy");
        if (!manifest.buildStrategies.includes(definition.id.trim().toLowerCase())) {
          throw new PlatformPluginRegistryError("platform_plugin_manifest_build_strategy_mismatch");
        }
        definitions.set(key, structuredClone(definition));
      }
      if (plugin.provisioningPolicyDefaults) {
        provisioningPolicyDefaults = mergePolicyDefaults(
          provisioningPolicyDefaults,
          plugin.provisioningPolicyDefaults,
        );
      }
      if (plugin.entryExperience && manifest.entryExperience !== plugin.entryExperience.id) {
        throw new PlatformPluginRegistryError("platform_plugin_manifest_entry_mismatch");
      }
      if (plugin.runtimeProfile) {
        try {
          validateRuntimeProfile(plugin.runtimeProfile);
        } catch {
          throw new PlatformPluginRegistryError("platform_plugin_runtime_profile_invalid");
        }
        if (!manifest.executionContracts?.includes(plugin.runtimeProfile.contract)) {
          throw new PlatformPluginRegistryError("platform_plugin_runtime_profile_contract_mismatch");
        }
        const existing = runtimeProfiles.get(plugin.runtimeProfile.contract);
        if (existing && !sameRuntimeProfile(existing, plugin.runtimeProfile)) {
          throw new PlatformPluginRegistryError("platform_plugin_runtime_profile_conflict");
        }
        runtimeProfiles.set(plugin.runtimeProfile.contract, cloneRuntimeProfile(plugin.runtimeProfile));
      }
      if (plugin.compatibility !== undefined) {
        let compatibility: AdapterCompatibility;
        try {
          compatibility = freezeCompatibility(validateAdapterCompatibility(plugin.compatibility));
        } catch {
          throw new PlatformPluginRegistryError("platform_plugin_compatibility_invalid");
        }
        const migration = compatibility.migration;
        if (migration) {
          const existing = migrationPlans.get(migration.id);
          const encoded = JSON.stringify(migration);
          if (existing !== undefined && existing !== encoded) {
            throw new PlatformPluginRegistryError("platform_plugin_conflicting_migration_plan");
          }
          migrationPlans.set(migration.id, encoded);
        }
        compatibilities.set(appId, compatibility);
      }
      if (plugin.legacy !== undefined) {
        let legacy: AdapterLegacyIntegration;
        try {
          legacy = validateAdapterLegacy(plugin.legacy);
        } catch {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_invalid");
        }
        if (legacy.catalog && legacy.catalog.appId !== appId) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_catalog_app_mismatch");
        }
        const legacyProviderId = legacy.auth?.providerId
          ?? legacy.auth?.provider?.id.trim().toLowerCase();
        if (legacyProviderId && !manifest.authProviders.includes(legacyProviderId)) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_auth_provider_mismatch");
        }
        if (legacyProviderId && !authProviders.has(legacyProviderId)) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_auth_provider_missing");
        }
        const registeredHandoff = handoffs.get(appId);
        if (legacy.auth?.cookieNames && registeredHandoff
          && !sameCookieNames(legacy.auth.cookieNames, registeredHandoff.managedCookieNames)) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_auth_cookie_mismatch");
        }
        if (legacy.auth?.handoff && !registeredHandoff) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_handoff_missing");
        }
        if (legacy.auth?.handoff && legacy.auth.handoff.appId.trim().toLowerCase() !== appId) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_handoff_app_mismatch");
        }
        if (legacy.auth?.handoff && registeredHandoff
          && !sameCookieNames(legacy.auth.handoff.managedCookieNames, registeredHandoff.managedCookieNames)) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_auth_cookie_mismatch");
        }
        if (legacy.runtime && !manifest.executionContracts?.includes(legacy.runtime.profile.contract)) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_runtime_contract_mismatch");
        }
        if (legacy.catalog?.bootstrap
          && !manifest.executionContracts?.includes(legacy.catalog.bootstrap.runtimeContract)) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_runtime_contract_mismatch");
        }
        if (legacy.catalog?.build
          && !manifest.executionContracts?.includes(legacy.catalog.build.runtimeContract)) {
          throw new PlatformPluginRegistryError("platform_plugin_legacy_runtime_contract_mismatch");
        }
        legacies.set(appId, freezeLegacy(legacy));
      }
      apps.set(appId, plugin);
      manifests.set(manifest.id, manifest);
    }

    this.#apps = apps;
    this.#manifests = [...manifests.values()];
    this.#handoffs = [...handoffs.values()];
    this.#authProviders = authProviders;
    this.#buildStrategies = [...strategies.values()];
    this.#strategyDefinitions = [...definitions.values()];
    this.#provisioningPolicyDefaults = structuredClone(provisioningPolicyDefaults);
    // 这些两个合同是平台层的中性能力，不代表任何具体 App；产品合同只有
    // 在插件清单中声明后才会进入 Provider descriptor。
    executionContracts.add(GENERIC_RUNTIME_CONTRACT);
    executionContracts.add(NO_RUNTIME_CONTRACT);
    this.#executionContracts = [...executionContracts];
    this.#runtimeProfiles = runtimeProfiles;
    this.#compatibilities = compatibilities;
    this.#legacies = legacies;
  }

  get(appId: string): AppIntegrationPlugin | undefined {
    const normalized = normalizeIdOrUndefined(appId);
    return normalized ? this.#apps.get(normalized) : undefined;
  }

  list(): readonly AppIntegrationPlugin[] {
    return [...this.#apps.values()];
  }

  manifests(): readonly PlatformPluginManifest[] {
    return this.#manifests.map((manifest) => ({
      ...manifest,
      authProviders: [...manifest.authProviders],
      appIntegrations: [...manifest.appIntegrations],
      buildStrategies: [...manifest.buildStrategies],
      ...(manifest.executionContracts ? { executionContracts: [...manifest.executionContracts] } : {}),
      capabilities: { ...manifest.capabilities },
    }));
  }

  appAuthHandoffs(): readonly AppAuthHandoff[] {
    return [...this.#handoffs];
  }

  authProviderIds(): readonly string[] {
    return [...this.#authProviders.keys()];
  }

  /**
   * 返回某个 App 在 manifest 中声明的 Provider；未声明时返回空列表。
   * 认证入口按 App 过滤，避免同一 Portal 中另一个插件的 Provider 泄漏到
   * 当前产品的登录页或被误当成默认认证方式。
   */
  authProviderIdsForApp(appId: string): readonly string[] {
    const plugin = this.get(appId);
    return plugin ? [...plugin.manifest.authProviders] : [];
  }

  /** 创建一次请求域外部认证服务，并核对实现没有冒充另一个 Provider。 */
  createAuthService(providerId: string): AuthService | undefined {
    const normalized = normalizeIdOrUndefined(providerId);
    if (!normalized) return undefined;
    const factory = this.#authProviders.get(normalized);
    if (!factory) return undefined;
    const service = factory.create();
    if (service.provider !== normalized) {
      throw new PlatformPluginRegistryError("platform_plugin_auth_provider_mismatch");
    }
    return service;
  }

  /** 构造一次平台级认证注册表；多个 App 对同一 Provider 共享该实例。 */
  createAuthProviderRegistry(options: AuthProviderRegistryOptions = { allowEmpty: true }): AuthProviderRegistry {
    const services = [...this.#authProviders.values()].map((factory) => {
      const service = factory.create();
      if (service.provider !== factory.id.trim().toLowerCase()) {
        throw new PlatformPluginRegistryError("platform_plugin_auth_provider_mismatch");
      }
      return service;
    });
    return new AuthProviderRegistry(services, options);
  }

  buildStrategyAdapters(): readonly BuildStrategyAdapter[] {
    return [...this.#buildStrategies];
  }

  /** 返回由已加载插件声明的执行合同，供组合根创建 Provider descriptor。 */
  executionContracts(): readonly string[] {
    return [...this.#executionContracts];
  }

  /** Runtime profiles are selected only from reviewed adapters, never from DB rows. */
  runtimeProfiles(): readonly RuntimeProfile[] {
    return [...this.#runtimeProfiles.values()].map(cloneRuntimeProfile);
  }

  runtimeProfileForContract(contract: string): RuntimeProfile | undefined {
    const profile = this.#runtimeProfiles.get(contract.trim().toLowerCase());
    return profile ? cloneRuntimeProfile(profile) : undefined;
  }

  releaseInspectorForApp(appId: string): import('@openapp/contracts').AdapterReleaseInspector | undefined {
    return this.get(appId)?.releaseInspector;
  }


  /** 返回适配器声明的兼容元数据副本，调用方不能修改注册表状态。 */
  compatibilityForApp(appId: string): AdapterCompatibility | undefined {
    const compatibility = this.#compatibilities.get(normalizeIdOrUndefined(appId) ?? "");
    return compatibility ? cloneCompatibility(compatibility) : undefined;
  }

  /** 返回某个 App 的迁移证据索引；没有声明迁移时返回 undefined。 */
  migrationPlanForApp(appId: string): AdapterMigrationPlan | undefined {
    return this.compatibilityForApp(appId)?.migration;
  }

  /** 返回 Adapter 所有的兼容岛能力；函数引用保持只读，不暴露注册表容器。 */
  legacyForApp(appId: string): AdapterLegacyIntegration | undefined {
    const legacy = this.#legacies.get(normalizeIdOrUndefined(appId) ?? "");
    return legacy ? cloneLegacy(legacy) : undefined;
  }

  /** 只读返回旧入口别名，供 Compatibility Host 做路由匹配。 */
  legacyRouteAliasesForApp(appId: string): AdapterLegacyIntegration["routes"] {
    return this.legacyForApp(appId)?.routes;
  }

  /** 返回 Adapter 声明的旧迁移适配器；Core 只可将其交给受限迁移端口。 */
  legacyMigrationForApp(appId: string): AdapterLegacyIntegration["migration"] {
    return this.legacyForApp(appId)?.migration;
  }

  /**
   * 返回某个 App 的默认构建策略。策略顺序由插件 manifest 固定，只有已经
   * 注册实现的策略才可被选中，避免把数据库字符串直接当成可执行代码。
   */
  defaultBuildStrategyId(appId: string): string | undefined {
    const plugin = this.get(appId);
    if (!plugin) return undefined;
    for (const strategyId of plugin.manifest.buildStrategies) {
      if (this.#buildStrategies.some((strategy) => strategy.id.trim().toLowerCase() === strategyId)) {
        return strategyId;
      }
    }
    return undefined;
  }

  /** 策略适用范围由已加载的插件声明，数据库历史记录不能授予执行能力。 */
  supportsBuildStrategy(appId: string, strategyId: string): boolean {
    return this.get(appId)?.manifest.buildStrategies.includes(strategyId.trim().toLowerCase()) === true;
  }

  appIdsForBuildStrategy(strategyId: string): string[] {
    return [...this.#apps.keys()].filter((appId) => this.supportsBuildStrategy(appId, strategyId));
  }

  /** 兼容列的产品含义由 Adapter 声明，冲突声明不能按加载顺序覆盖。 */
  legacyPackageColumns(): Record<string, Record<string, string>> {
    const result: Record<string, Record<string, string>> = {};
    for (const plugin of this.#apps.values()) {
      const columns = plugin.releaseInspector?.legacyPackageColumns;
      if (columns && Object.keys(columns).length) result[plugin.appId] = { ...columns };
    }
    return result;
  }

  /** Returns immutable durable strategy metadata for catalog initialization. */
  buildStrategyDefinitions(): readonly BuildStrategy[] {
    return this.#strategyDefinitions.map((strategy) => structuredClone(strategy));
  }

  /** 返回由 Adapter 声明的持久化策略默认值，不读取数据库或请求输入。 */
  provisioningPolicyDefaults(): ProvisioningPolicyDefaults {
    const defaults = structuredClone(this.#provisioningPolicyDefaults);
    // 单 App 部署无需重复声明同一个 id；多 App 部署必须由部署清单选择默认项。
    if (!defaults.defaultAppId && this.#apps.size === 1) {
      defaults.defaultAppId = this.#apps.keys().next().value;
    }
    return defaults;
  }

  entryExperience(appId: string): EntryExperienceManifest | undefined {
    const entry = this.get(appId)?.entryExperience;
    return entry
      ? { ...entry, ...(entry.fields ? { fields: entry.fields.map((field) => ({ ...field })) } : {}) }
      : undefined;
  }

  /**
   * 返回入口所需的稳定 manifest。没有专用主题的 App 使用平台通用主题，
   * 这样新增普通单体项目时不需要在前端增加 App 分支。
   */
  workspaceEntryManifest(appId: string, appName?: string): WorkspaceEntryManifest | undefined {
    const normalizedAppId = normalizeIdOrUndefined(appId);
    const plugin = normalizedAppId ? this.#apps.get(normalizedAppId) : undefined;
    if (!plugin) return undefined;
    const entry = plugin.entryExperience ?? {
      id: "generic-workspace",
      label: appName?.trim() || plugin.appId,
      logoUrl: "/openapp-logo.png",
      challenge: plugin.manifest.authProviders.length > 0 ? "email_code" as const : "none" as const,
      defaultWorkspace: "personal" as const,
    };
    return {
      appId: plugin.appId,
      appName: appName?.trim() || entry.label,
      ...(plugin.manifest.authProviders[0]
        ? { authProviderId: plugin.manifest.authProviders[0] }
        : {}),
      entry: { ...entry, ...(entry.fields ? { fields: entry.fields.map((field) => ({ ...field })) } : {}) },
      capabilities: { ...plugin.manifest.capabilities },
      ...(normalizedAppId && this.#compatibilities.get(normalizedAppId)?.errorCatalog
        ? { errorCatalog: cloneErrorCatalog(this.#compatibilities.get(normalizedAppId)!.errorCatalog!) }
        : {}),
    };
  }

  supportsCredentialedApp(appId: string): boolean {
    return Boolean(this.get(appId)?.authHandoff);
  }
}

function cloneRuntimeProfile(profile: RuntimeProfile): RuntimeProfile {
  return Object.freeze({
    ...profile,
    command: Object.freeze([...profile.command]),
    ...(profile.lockRecoveryEnvironment ? { lockRecoveryEnvironment: Object.freeze({ ...profile.lockRecoveryEnvironment }) } : {}),
    ...(profile.recoveryCommand ? { recoveryCommand: Object.freeze([...profile.recoveryCommand]) } : {}),
    reservedEnvironment: Object.freeze([...profile.reservedEnvironment]),
    ...(profile.providerEnvironment
      ? { providerEnvironment: Object.freeze({ ...profile.providerEnvironment }) }
      : {}),
    ...(profile.legacyResourcePrefixes
      ? {
        legacyResourcePrefixes: Object.freeze({
          ...profile.legacyResourcePrefixes,
          ...(profile.legacyResourcePrefixes.network ? { network: Object.freeze([...profile.legacyResourcePrefixes.network]) } : {}),
          ...(profile.legacyResourcePrefixes.container ? { container: Object.freeze([...profile.legacyResourcePrefixes.container]) } : {}),
          ...(profile.legacyResourcePrefixes.volume ? { volume: Object.freeze([...profile.legacyResourcePrefixes.volume]) } : {}),
          ...(profile.legacyResourcePrefixes.label ? { label: Object.freeze([...profile.legacyResourcePrefixes.label]) } : {}),
        }),
      }
      : {}),
  });
}

function sameRuntimeProfile(left: RuntimeProfile, right: RuntimeProfile): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function freezeCompatibility(value: AdapterCompatibility): AdapterCompatibility {
  return Object.freeze({
    ...(value.legacyAliases
      ? {
        legacyAliases: Object.freeze({
          ...value.legacyAliases,
          ...(value.legacyAliases.appIds ? { appIds: Object.freeze([...value.legacyAliases.appIds]) } : {}),
          ...(value.legacyAliases.providerIds ? { providerIds: Object.freeze([...value.legacyAliases.providerIds]) } : {}),
          ...(value.legacyAliases.environmentKeys ? { environmentKeys: Object.freeze([...value.legacyAliases.environmentKeys]) } : {}),
          ...(value.legacyAliases.cookieNames ? { cookieNames: Object.freeze([...value.legacyAliases.cookieNames]) } : {}),
          ...(value.legacyAliases.routeAliases ? { routeAliases: Object.freeze([...value.legacyAliases.routeAliases]) } : {}),
        }),
      }
      : {}),
    ...(value.errorCatalog ? { errorCatalog: cloneErrorCatalog(value.errorCatalog) } : {}),
    ...(value.migration
      ? {
        migration: Object.freeze({
          ...value.migration,
          ...(value.migration.preserves ? { preserves: Object.freeze([...value.migration.preserves]) } : {}),
        }),
      }
      : {}),
  });
}

function cloneCompatibility(value: AdapterCompatibility): AdapterCompatibility {
  return freezeCompatibility(value);
}

function cloneErrorCatalog(value: AdapterErrorCatalog): AdapterErrorCatalog {
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([locale, messages]) => [
      locale,
      Object.freeze({ ...messages }),
    ]),
  )) as AdapterErrorCatalog;
}

function freezeLegacy(value: AdapterLegacyIntegration): AdapterLegacyIntegration {
  const routes = value.routes
    ? Object.freeze({
      ...value.routes,
      ...(value.routes.control ? { control: Object.freeze([...value.routes.control]) } : {}),
      ...(value.routes.auth ? { auth: Object.freeze([...value.routes.auth]) } : {}),
      ...(value.routes.all ? { all: Object.freeze([...value.routes.all]) } : {}),
    })
    : undefined;
  const auth = value.auth
    ? Object.freeze({
      ...value.auth,
      ...(value.auth.cookieNames ? { cookieNames: Object.freeze([...value.auth.cookieNames]) } : {}),
      ...(value.auth.routeAliases ? { routeAliases: freezeLegacyRoutes(value.auth.routeAliases) } : {}),
    })
    : undefined;
  const catalog = value.catalog
    ? Object.freeze({
      ...value.catalog,
      ...(value.catalog.bootstrap ? { bootstrap: Object.freeze({ ...value.catalog.bootstrap }) } : {}),
      ...(value.catalog.build ? {
        build: Object.freeze({
          ...value.catalog.build,
          packageRequirements: Object.freeze(value.catalog.build.packageRequirements.map((item) => Object.freeze({
            ...item,
            acceptedExtensions: Object.freeze([...item.acceptedExtensions]),
          }))),
        }),
      } : {}),
    })
    : undefined;
  const runtime = value.runtime
    ? Object.freeze({
      ...value.runtime,
      profile: cloneRuntimeProfileFromContract(value.runtime.profile),
      ...(value.runtime.resourcePrefixes ? { resourcePrefixes: cloneResourcePrefixes(value.runtime.resourcePrefixes) } : {}),
    })
    : undefined;
  const projection = value.projection ? Object.freeze({ ...value.projection }) : undefined;
  const migration = value.migration
    ? Object.freeze({
      ...value.migration,
      plan: Object.freeze({
        ...value.migration.plan,
        ...(value.migration.plan.preserves
          ? { preserves: Object.freeze([...value.migration.plan.preserves]) }
          : {}),
      }),
    })
    : undefined;
  return Object.freeze({
    ...(routes ? { routes } : {}),
    ...(auth ? { auth } : {}),
    ...(catalog ? { catalog } : {}),
    ...(runtime ? { runtime } : {}),
    ...(projection ? { projection } : {}),
    ...(migration ? { migration } : {}),
  });
}

function cloneLegacy(value: AdapterLegacyIntegration): AdapterLegacyIntegration {
  return freezeLegacy(value);
}

function freezeLegacyRoutes(value: NonNullable<AdapterLegacyIntegration["routes"]>): NonNullable<AdapterLegacyIntegration["routes"]> {
  return Object.freeze({
    ...value,
    ...(value.control ? { control: Object.freeze([...value.control]) } : {}),
    ...(value.auth ? { auth: Object.freeze([...value.auth]) } : {}),
    ...(value.all ? { all: Object.freeze([...value.all]) } : {}),
  });
}

function cloneRuntimeProfileFromContract(
  profile: NonNullable<NonNullable<AdapterLegacyIntegration["runtime"]>["profile"]>,
): RuntimeProfile {
  return Object.freeze({
    ...profile,
    command: Object.freeze([...profile.command]),
    ...(profile.lockRecoveryEnvironment ? { lockRecoveryEnvironment: Object.freeze({ ...profile.lockRecoveryEnvironment }) } : {}),
    ...(profile.recoveryCommand ? { recoveryCommand: Object.freeze([...profile.recoveryCommand]) } : {}),
    reservedEnvironment: Object.freeze([...profile.reservedEnvironment]),
    ...(profile.providerEnvironment ? { providerEnvironment: Object.freeze({ ...profile.providerEnvironment }) } : {}),
    ...(profile.legacyResourcePrefixes ? { legacyResourcePrefixes: cloneResourcePrefixes(profile.legacyResourcePrefixes) } : {}),
  }) as RuntimeProfile;
}

function cloneResourcePrefixes(
  value: NonNullable<NonNullable<AdapterLegacyIntegration["runtime"]>["resourcePrefixes"]>,
): NonNullable<NonNullable<AdapterLegacyIntegration["runtime"]>["resourcePrefixes"]> {
  return Object.freeze({
    ...value,
    ...(value.network ? { network: Object.freeze([...value.network]) } : {}),
    ...(value.container ? { container: Object.freeze([...value.container]) } : {}),
    ...(value.volume ? { volume: Object.freeze([...value.volume]) } : {}),
    ...(value.label ? { label: Object.freeze([...value.label]) } : {}),
  });
}

function validateManifest(manifest: PlatformPluginManifest, appId: string): PlatformPluginManifest {
  if (!manifest || typeof manifest !== "object") {
    throw new PlatformPluginRegistryError("platform_plugin_manifest_required");
  }
  const id = normalizeId(manifest.id, "platform_plugin_invalid_manifest_id");
  const apiVersion = normalizeVersion(manifest.apiVersion, "platform_plugin_invalid_api_version");
  const version = normalizeVersion(manifest.version, "platform_plugin_invalid_version");
  if (!Array.isArray(manifest.authProviders) || !Array.isArray(manifest.appIntegrations)
    || !Array.isArray(manifest.buildStrategies)) {
    throw new PlatformPluginRegistryError("platform_plugin_manifest_lists_required");
  }
  const appIntegrations = normalizeIds(manifest.appIntegrations, "platform_plugin_invalid_app_integrations");
  const authProviders = normalizeIds(manifest.authProviders, "platform_plugin_invalid_auth_providers");
  const buildStrategies = normalizeIds(manifest.buildStrategies, "platform_plugin_invalid_build_strategies");
  const executionContracts = manifest.executionContracts === undefined
    ? undefined
    : normalizeExecutionContracts(manifest.executionContracts);
  if (new Set(appIntegrations).size !== appIntegrations.length
    || new Set(authProviders).size !== authProviders.length
    || new Set(buildStrategies).size !== buildStrategies.length) {
    throw new PlatformPluginRegistryError("platform_plugin_manifest_duplicate_reference");
  }
  if (id !== appId) throw new PlatformPluginRegistryError("platform_plugin_manifest_id_mismatch");
  if (manifest.entryExperience !== undefined && !normalizeIdOrUndefined(manifest.entryExperience)) {
    throw new PlatformPluginRegistryError("platform_plugin_invalid_entry_experience");
  }
  if (!manifest.capabilities || typeof manifest.capabilities !== "object" || Array.isArray(manifest.capabilities)) {
    throw new PlatformPluginRegistryError("platform_plugin_capabilities_required");
  }
  if (Object.values(manifest.capabilities).some((value) => typeof value !== "boolean")) {
    throw new PlatformPluginRegistryError("platform_plugin_capabilities_invalid");
  }
  return {
    ...manifest,
    id,
    apiVersion,
    version,
    authProviders,
    appIntegrations,
    buildStrategies,
    ...(executionContracts ? { executionContracts } : {}),
    ...(manifest.entryExperience === undefined ? {} : { entryExperience: manifest.entryExperience.trim().toLowerCase() }),
    capabilities: { ...manifest.capabilities },
  };
}

function normalizeExecutionContracts(values: readonly unknown[]): string[] {
  if (!Array.isArray(values)) throw new PlatformPluginRegistryError("platform_plugin_invalid_execution_contracts");
  const normalized = values.map((value) => {
    const contract = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(contract)) {
      throw new PlatformPluginRegistryError("platform_plugin_invalid_execution_contracts");
    }
    return contract;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new PlatformPluginRegistryError("platform_plugin_manifest_duplicate_reference");
  }
  return normalized;
}

function normalizeIds(values: readonly unknown[], code: string): string[] {
  return values.map((value) => normalizeId(value, code));
}

function normalizeId(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!APP_ID_PATTERN.test(normalized)) throw new PlatformPluginRegistryError(code);
  return normalized;
}

function normalizeIdOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  return APP_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeVersion(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 64 || /[\r\n]/u.test(normalized)) {
    throw new PlatformPluginRegistryError(code);
  }
  return normalized;
}

function mergePolicyDefaults(
  current: ProvisioningPolicyDefaults,
  incoming: ProvisioningPolicyDefaults,
): ProvisioningPolicyDefaults {
  if (current.defaultAppId !== undefined
    && incoming.defaultAppId !== undefined
    && current.defaultAppId.trim().toLowerCase() !== incoming.defaultAppId.trim().toLowerCase()) {
    throw new PlatformPluginRegistryError("platform_plugin_conflicting_default_app");
  }
  return {
    ...current,
    ...incoming,
    ...(incoming.resources || current.resources
      ? { resources: { ...current.resources, ...incoming.resources } }
      : {}),
    ...(incoming.environment || current.environment
      ? { environment: { ...current.environment, ...incoming.environment } }
      : {}),
    ...(incoming.configFiles || current.configFiles
      ? { configFiles: { ...current.configFiles, ...incoming.configFiles } }
      : {}),
  };
}

function strategyKey(id: string, revision: number): string {
  const normalized = normalizeId(id, "platform_plugin_invalid_build_strategy");
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new PlatformPluginRegistryError("platform_plugin_invalid_build_strategy_revision");
  }
  return `${normalized}@${revision}`;
}

function sameCookieNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightNames = new Set(right.map((name) => name.trim().toLowerCase()));
  return left.every((name) => rightNames.has(name.trim().toLowerCase()));
}
