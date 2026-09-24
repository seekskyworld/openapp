import { ProviderAuthResponseError } from "./auth/provider-compatibility.js";
import {
  OPENAPP_ADAPTER_API_VERSION,
  validateAdapterCompatibility,
  validateAdapterLegacy,
  validateAdapterManifest,
  validateUploadRequirements,
  type AdapterCompatibility,
  type AdapterLegacyIntegration,
  type AdapterAuthHandoff,
  type AdapterAuthLoginInput,
  type AdapterAuthLogoutInput,
  type AdapterAuthProvider,
  type AdapterAuthRevocationReason,
  type AdapterCredentialGrant,
  type AdapterModuleHost,
  type AdapterReleaseInspector,
  type AdapterRuntimeProfile,
  type AppAdapterManifest,
  type OpenAppAdapter,
  type OpenAppAdapterFactory,
} from "@openapp/contracts";
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isAbsolute, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppAuthHandoff, AppAuthLoginInput, AppAuthLogoutInput, AppAuthProxyInput } from "./auth/app-auth-handoff.js";
import type {
  AuthCredentialGrant,
  AuthEmailCodeResult,
  AuthLoginInput,
  AuthProviderField,
  AuthService,
} from "./auth/types.js";
import type { OciArtifactManagementPort } from "./artifact-provider.js";
import type {
  AppIntegrationPlugin,
  AuthProviderPlugin,
  EntryExperienceManifest,
} from "./platform-plugins.js";
import type { BuildStrategyAdapter } from "./build-strategies.js";
import type { BuildStrategy } from "./models.js";
import { validateRuntimeProfile, type RuntimeProfile } from "./runtime.js";

/** Errors raised while loading a code-owned adapter module. */
export class ExternalAdapterError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
  }
}

export interface ExternalAdapterLoadOptions {
  /** Absolute path, file URL, or a package specifier selected by deployment. */
  readonly moduleSpecifier: string;
  /** Optional filesystem roots approved to contain file-based adapters. */
  readonly approvedModuleRoots?: readonly string[];
  /** Optional exact package names approved for package-based adapters. */
  readonly approvedPackageSpecifiers?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly artifacts: OciArtifactManagementPort;
  readonly releaseInspector?: AdapterReleaseInspector;
  readonly scriptPath?: string;
  readonly runCommand?: import("./build-strategies.js").BuildCommandRunner;
}

/**
 * Loads one reviewed external App adapter and converts it at the anti-corruption
 * boundary into the internal plugin contract. No HTTP or database value reaches
 * this function; module selection is deployment-owned configuration.
 */
export async function loadExternalAppAdapter(
  options: ExternalAdapterLoadOptions,
): Promise<AppIntegrationPlugin> {
  const moduleSpecifier = await normalizeModuleSpecifier(
    options.moduleSpecifier,
    options.approvedModuleRoots,
    options.approvedPackageSpecifiers,
  );
  const environment = { ...(options.environment ?? process.env) };
  const releaseInspector = options.releaseInspector ?? defaultReleaseInspector();
  let moduleNamespace: Record<string, unknown>;
  try {
    moduleNamespace = await import(moduleSpecifier) as Record<string, unknown>;
  } catch (error) {
    throw new ExternalAdapterError("external_adapter_module_load_failed", { cause: error });
  }
  const factory = selectFactory(moduleNamespace);
  let adapter: OpenAppAdapter;
  try {
    adapter = await factory({ environment, releaseInspector, artifacts: options.artifacts, runCommand: options.runCommand, buildScriptPath: options.scriptPath });
  } catch (error) {
    throw new ExternalAdapterError("external_adapter_factory_failed", { cause: error });
  }
  return convertAdapter(adapter, {
    ...options,
    environment,
    releaseInspector,
  });
}

/** Converts an already-created adapter; useful for deterministic unit tests. */
export function convertExternalAppAdapter(
  adapter: OpenAppAdapter,
  options: Omit<ExternalAdapterLoadOptions, "moduleSpecifier">,
): AppIntegrationPlugin {
  return convertAdapter(adapter, options);
}

function convertAdapter(
  candidate: OpenAppAdapter,
  options: Omit<ExternalAdapterLoadOptions, "moduleSpecifier">,
): AppIntegrationPlugin {
  if (!candidate || typeof candidate !== "object") {
    throw new ExternalAdapterError("external_adapter_invalid");
  }
  let manifest: AppAdapterManifest;
  try {
    manifest = validateAdapterManifest(candidate.manifest);
  } catch (error) {
    throw new ExternalAdapterError(
      error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "external_adapter_manifest_invalid",
      { cause: error },
    );
  }
  if (manifest.apiVersion !== OPENAPP_ADAPTER_API_VERSION) {
    throw new ExternalAdapterError("external_adapter_api_version_unsupported");
  }
  const appId = manifest.id;
  const provider = candidate.authProvider;
  const authManifest = manifest.auth;
  if (provider && !authManifest) throw new ExternalAdapterError("external_adapter_auth_manifest_missing");
  if (authManifest && authManifest.protocol !== "none" && !provider) {
    throw new ExternalAdapterError("external_adapter_auth_provider_missing");
  }
  if (provider && (!authManifest || provider.id.trim().toLowerCase() !== authManifest.providerId)) {
    throw new ExternalAdapterError("external_adapter_auth_provider_mismatch");
  }
  const handoff = candidate.authHandoff;
  if (handoff && handoff.appId.trim().toLowerCase() !== appId) {
    throw new ExternalAdapterError("external_adapter_handoff_app_mismatch");
  }
  if (handoff && (typeof handoff.onLogin !== "function"
    || typeof handoff.onLogout !== "function"
    || typeof handoff.proxyOptions !== "function")) {
    throw new ExternalAdapterError("external_adapter_handoff_invalid");
  }
  if (handoff && !provider && authManifest?.protocol !== "none") {
    throw new ExternalAdapterError("external_adapter_handoff_provider_missing");
  }
  const buildProfile = candidate.buildProfile ?? manifest.build;
  if (candidate.buildProfile && !sameBuildProfile(candidate.buildProfile, manifest.build)) {
    throw new ExternalAdapterError("external_adapter_build_profile_mismatch");
  }
  if (buildProfile && buildProfile.runtimeContract !== manifest.workload.runtimeContract) {
    throw new ExternalAdapterError("external_adapter_build_runtime_mismatch");
  }
  const compatibility = resolveAdapterCompatibility(candidate.compatibility, manifest.compatibility);
  const legacy = resolveAdapterLegacy(candidate.legacy, {
    appId,
    provider,
    handoff,
    buildProfile,
    runtimeContract: manifest.workload.runtimeContract,
    compatibility,
  });
  const entry = toEntryExperience(manifest);
  const runtimeProfile = manifest.workload.runtime
    ? toRuntimeProfile(manifest.workload.runtime, manifest.workload.runtimeContract)
    : undefined;
  const strategyDefinition = buildProfile ? toStrategyDefinition(manifest, buildProfile) : undefined;
  const strategyAdapter = candidate.buildStrategy;
  if (strategyAdapter && (!buildProfile || strategyAdapter.id !== buildProfile.strategyId
    || strategyAdapter.revision !== buildProfile.revision || typeof strategyAdapter.execute !== "function")) {
    throw new ExternalAdapterError("external_adapter_build_implementation_mismatch");
  }
  const releaseInspector = candidate.releaseInspector;
  if (releaseInspector && (releaseInspector.uploadRequirements || releaseInspector.inspectUpload)) {
    if (typeof releaseInspector.inspectUpload !== "function") throw new ExternalAdapterError("external_adapter_upload_inspector_missing");
    validateUploadRequirements(releaseInspector.uploadRequirements);
  }
  const appPlugin: AppIntegrationPlugin = {
    appId,
    releaseInspector: candidate.releaseInspector,
    manifest: {
      id: appId,
      apiVersion: manifest.apiVersion,
      version: manifest.version,
      authProviders: provider && authManifest && authManifest.protocol !== "none" ? [authManifest.providerId] : [],
      appIntegrations: [appId],
      buildStrategies: strategyDefinition ? [strategyDefinition.id] : [],
      executionContracts: [manifest.workload.runtimeContract],
      entryExperience: entry.id,
      capabilities: { ...manifest.capabilities },
    },
    entryExperience: entry,
    ...(provider && authManifest && authManifest.protocol !== "none"
      ? { authProviders: [toAuthProviderPlugin(provider, authManifest, manifest)] }
      : {}),
    ...(handoff ? { authHandoff: toAuthHandoff(handoff) } : {}),
    ...(strategyAdapter ? { buildStrategies: [strategyAdapter] } : {}),
    ...(strategyDefinition ? { strategyDefinitions: [strategyDefinition] } : {}),
    ...(runtimeProfile ? { runtimeProfile } : {}),
    ...(compatibility ? { compatibility } : {}),
    ...(legacy ? { legacy } : {}),
    ...(manifest.catalogBootstrap
      ? {
        catalogBootstrap: {
          app: {
            id: appId,
            name: manifest.name,
            description: manifest.description,
            authAdapterId: handoff ? appId : "none",
          },
          legacyVersion: {
            version: manifest.catalogBootstrap.version,
            imageReference: manifest.catalogBootstrap.imageReference,
            runtimeContract: manifest.catalogBootstrap.runtimeContract,
          },
        },
      }
      : {}),
  };
  return appPlugin;
}

/**
 * 将 Adapter 的兼容岛固定在同一个 App 身份下。兼容能力可以复用普通入口
 * 的 Provider/handoff，但不能暗中替换它们或声明另一个 App 的 Runtime。
 */
function resolveAdapterLegacy(
  value: unknown,
  context: {
    appId: string;
    provider: AdapterAuthProvider | undefined;
    handoff: AdapterAuthHandoff | undefined;
    buildProfile: AppAdapterManifest["build"] | undefined;
    runtimeContract: string;
    compatibility: AdapterCompatibility | undefined;
  },
): AdapterLegacyIntegration | undefined {
  if (value === undefined) return undefined;
  let legacy: AdapterLegacyIntegration;
  try {
    legacy = validateAdapterLegacy(value);
  } catch (error) {
    throw new ExternalAdapterError(
      error instanceof Error && "code" in error
        ? String((error as { code: unknown }).code)
        : "external_adapter_legacy_invalid",
      { cause: error },
    );
  }
  if (legacy.catalog?.appId !== undefined && legacy.catalog.appId !== context.appId) {
    throw new ExternalAdapterError("external_adapter_legacy_catalog_app_mismatch");
  }
  if (legacy.catalog?.defaultAppId !== undefined && legacy.catalog.defaultAppId !== context.appId) {
    throw new ExternalAdapterError("external_adapter_legacy_catalog_default_app_mismatch");
  }
  if (legacy.auth?.provider && !context.provider) {
    throw new ExternalAdapterError("external_adapter_legacy_auth_provider_missing");
  }
  if (legacy.auth?.providerId && !context.provider) {
    // 只有声明了普通 Provider 实例，Core 才能把兼容路由绑定到可用的认证服务。
    // 否则路由虽然存在，却永远无法完成登录，必须在装载阶段拒绝。
    throw new ExternalAdapterError("external_adapter_legacy_auth_provider_missing");
  }
  if (legacy.auth?.handoff && !context.handoff) {
    throw new ExternalAdapterError("external_adapter_legacy_handoff_missing");
  }
  if (legacy.auth?.provider && context.provider
    && legacy.auth.provider.id.trim().toLowerCase() !== context.provider.id.trim().toLowerCase()) {
    throw new ExternalAdapterError("external_adapter_legacy_auth_provider_mismatch");
  }
  if (legacy.auth?.provider && context.provider && legacy.auth.provider !== context.provider) {
    throw new ExternalAdapterError("external_adapter_legacy_auth_provider_mismatch");
  }
  if (legacy.auth?.providerId && context.provider
    && legacy.auth.providerId !== context.provider.id.trim().toLowerCase()) {
    throw new ExternalAdapterError("external_adapter_legacy_auth_provider_mismatch");
  }
  if (legacy.auth?.handoff && context.handoff
    && legacy.auth.handoff.appId.trim().toLowerCase() !== context.handoff.appId.trim().toLowerCase()) {
    throw new ExternalAdapterError("external_adapter_legacy_handoff_mismatch");
  }
  if (legacy.auth?.handoff && context.handoff && legacy.auth.handoff !== context.handoff) {
    throw new ExternalAdapterError("external_adapter_legacy_handoff_mismatch");
  }
  if (legacy.auth?.cookieNames && context.handoff
    && !sameCookieNames(legacy.auth.cookieNames, context.handoff.managedCookieNames)) {
    throw new ExternalAdapterError("external_adapter_legacy_auth_cookie_mismatch");
  }
  if (legacy.runtime && legacy.runtime.profile.contract !== context.runtimeContract) {
    throw new ExternalAdapterError("external_adapter_legacy_runtime_contract_mismatch");
  }
  if (legacy.catalog?.bootstrap
    && legacy.catalog.bootstrap.runtimeContract !== context.runtimeContract) {
    throw new ExternalAdapterError("external_adapter_legacy_runtime_contract_mismatch");
  }
  if (legacy.catalog?.build
    && legacy.catalog.build.runtimeContract !== context.runtimeContract) {
    throw new ExternalAdapterError("external_adapter_legacy_runtime_contract_mismatch");
  }
  if (legacy.catalog?.build && context.buildProfile
    && !sameBuildProfile(legacy.catalog.build, context.buildProfile)) {
    throw new ExternalAdapterError("external_adapter_legacy_build_profile_mismatch");
  }
  if (legacy.migration && context.compatibility?.migration
    && JSON.stringify(legacy.migration.plan) !== JSON.stringify(context.compatibility.migration)) {
    throw new ExternalAdapterError("external_adapter_legacy_migration_mismatch");
  }
  return freezeLegacyIntegration(legacy);
}

function freezeLegacyIntegration(value: AdapterLegacyIntegration): AdapterLegacyIntegration {
  return Object.freeze({
    ...(value.routes ? {
      routes: Object.freeze({
        ...value.routes,
        ...(value.routes.control ? { control: Object.freeze([...value.routes.control]) } : {}),
        ...(value.routes.auth ? { auth: Object.freeze([...value.routes.auth]) } : {}),
        ...(value.routes.all ? { all: Object.freeze([...value.routes.all]) } : {}),
      }),
    } : {}),
    ...(value.auth ? {
      auth: Object.freeze({
        ...value.auth,
        ...(value.auth.cookieNames ? { cookieNames: Object.freeze([...value.auth.cookieNames]) } : {}),
        ...(value.auth.routeAliases ? {
          routeAliases: Object.freeze({
            ...value.auth.routeAliases,
            ...(value.auth.routeAliases.control ? { control: Object.freeze([...value.auth.routeAliases.control]) } : {}),
            ...(value.auth.routeAliases.auth ? { auth: Object.freeze([...value.auth.routeAliases.auth]) } : {}),
            ...(value.auth.routeAliases.all ? { all: Object.freeze([...value.auth.routeAliases.all]) } : {}),
          }),
        } : {}),
      }),
    } : {}),
    ...(value.catalog ? {
      catalog: Object.freeze({
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
      }),
    } : {}),
    ...(value.runtime ? {
      runtime: Object.freeze({
        ...value.runtime,
        profile: Object.freeze({
          ...value.runtime.profile,
          command: Object.freeze([...value.runtime.profile.command]),
          ...(value.runtime.profile.lockRecoveryEnvironment ? { lockRecoveryEnvironment: Object.freeze({ ...value.runtime.profile.lockRecoveryEnvironment }) } : {}),
          ...(value.runtime.profile.recoveryCommand ? { recoveryCommand: Object.freeze([...value.runtime.profile.recoveryCommand]) } : {}),
          reservedEnvironment: Object.freeze([...value.runtime.profile.reservedEnvironment]),
          ...(value.runtime.profile.providerEnvironment
            ? { providerEnvironment: Object.freeze({ ...value.runtime.profile.providerEnvironment }) }
            : {}),
          ...(value.runtime.profile.legacyResourcePrefixes
            ? {
              legacyResourcePrefixes: Object.freeze({
                ...value.runtime.profile.legacyResourcePrefixes,
                ...(value.runtime.profile.legacyResourcePrefixes.network ? { network: Object.freeze([...value.runtime.profile.legacyResourcePrefixes.network]) } : {}),
                ...(value.runtime.profile.legacyResourcePrefixes.container ? { container: Object.freeze([...value.runtime.profile.legacyResourcePrefixes.container]) } : {}),
                ...(value.runtime.profile.legacyResourcePrefixes.volume ? { volume: Object.freeze([...value.runtime.profile.legacyResourcePrefixes.volume]) } : {}),
                ...(value.runtime.profile.legacyResourcePrefixes.label ? { label: Object.freeze([...value.runtime.profile.legacyResourcePrefixes.label]) } : {}),
              }),
            }
            : {}),
        }),
        ...(value.runtime.resourcePrefixes ? {
          resourcePrefixes: Object.freeze({
            ...value.runtime.resourcePrefixes,
            ...(value.runtime.resourcePrefixes.network ? { network: Object.freeze([...value.runtime.resourcePrefixes.network]) } : {}),
            ...(value.runtime.resourcePrefixes.container ? { container: Object.freeze([...value.runtime.resourcePrefixes.container]) } : {}),
            ...(value.runtime.resourcePrefixes.volume ? { volume: Object.freeze([...value.runtime.resourcePrefixes.volume]) } : {}),
            ...(value.runtime.resourcePrefixes.label ? { label: Object.freeze([...value.runtime.resourcePrefixes.label]) } : {}),
          }),
        } : {}),
      }),
    } : {}),
    ...(value.projection ? { projection: Object.freeze({ ...value.projection }) } : {}),
    ...(value.migration ? {
      migration: Object.freeze({
        ...value.migration,
        plan: Object.freeze({
          ...value.migration.plan,
          ...(value.migration.plan.preserves ? { preserves: Object.freeze([...value.migration.plan.preserves]) } : {}),
        }),
      }),
    } : {}),
  });
}

/**
 * 适配器对象和 manifest 可以分别声明兼容元数据，但二者不能悄悄分叉。
 * 先经过公开 contracts 校验，再在 Core 边界做深拷贝/冻结，避免外部模块
 * 在注册后修改别名或错误文案。
 */
function resolveAdapterCompatibility(
  candidateValue: unknown,
  manifestValue: AdapterCompatibility | undefined,
): AdapterCompatibility | undefined {
  let candidate: AdapterCompatibility | undefined;
  if (candidateValue !== undefined) {
    try {
      candidate = freezeCompatibility(validateAdapterCompatibility(candidateValue));
    } catch (error) {
      throw new ExternalAdapterError(
        error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "external_adapter_compatibility_invalid",
        { cause: error },
      );
    }
  }
  const manifest = manifestValue === undefined
    ? undefined
    : freezeCompatibility(manifestValue);
  if (candidate && manifest && !isDeepStrictEqual(candidate, manifest)) {
    throw new ExternalAdapterError("external_adapter_compatibility_mismatch");
  }
  return candidate ?? manifest;
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
    ...(value.errorCatalog
      ? {
        errorCatalog: Object.freeze(Object.fromEntries(
          Object.entries(value.errorCatalog).map(([locale, messages]) => [locale, Object.freeze({ ...messages })]),
        )),
      }
      : {}),
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

/** Converts the serialisable adapter profile into the internal runtime port. */
function toRuntimeProfile(
  profile: AdapterRuntimeProfile,
  expectedContract: string,
): RuntimeProfile {
  if (profile.contract !== undefined && profile.contract !== expectedContract) {
    throw new ExternalAdapterError("external_adapter_runtime_contract_mismatch");
  }
  const converted: RuntimeProfile = {
    id: profile.id,
    contract: expectedContract,
    ...(profile.environmentPrefix === undefined ? {} : { environmentPrefix: profile.environmentPrefix }),
    ...(profile.defaultImage === undefined ? {} : { defaultImage: profile.defaultImage }),
    ...(profile.defaultNetworkPrefix === undefined ? {} : { defaultNetworkPrefix: profile.defaultNetworkPrefix }),
    ...(profile.defaultContainerPrefix === undefined ? {} : { defaultContainerPrefix: profile.defaultContainerPrefix }),
    ...(profile.defaultVolumePrefix === undefined ? {} : { defaultVolumePrefix: profile.defaultVolumePrefix }),
    labelPrefix: profile.labelPrefix,
    storageClass: profile.storageClass,
    storageMountPath: profile.storageMountPath,
    containerPort: profile.containerPort,
    containerUser: profile.containerUser,
    entrypoint: profile.entrypoint,
    command: [...profile.command],
    ...(profile.recoveryCommand ? { recoveryCommand: [...profile.recoveryCommand] } : {}),
    configEnvironmentKey: profile.configEnvironmentKey,
    ...(profile.lockRecoveryEnvironment ? { lockRecoveryEnvironment: { ...profile.lockRecoveryEnvironment } } : {}),
    reservedEnvironment: [...profile.reservedEnvironment],
    healthPath: profile.healthPath,
    ...(profile.providerEnvironment === undefined ? {} : {
      providerEnvironment: {
        ...profile.providerEnvironment,
      },
    }),
    ...(profile.legacyResourcePrefixes === undefined ? {} : {
      legacyResourcePrefixes: {
        ...profile.legacyResourcePrefixes,
        ...(profile.legacyResourcePrefixes.network === undefined ? {} : { network: [...profile.legacyResourcePrefixes.network] }),
        ...(profile.legacyResourcePrefixes.container === undefined ? {} : { container: [...profile.legacyResourcePrefixes.container] }),
        ...(profile.legacyResourcePrefixes.volume === undefined ? {} : { volume: [...profile.legacyResourcePrefixes.volume] }),
        ...(profile.legacyResourcePrefixes.label === undefined ? {} : { label: [...profile.legacyResourcePrefixes.label] }),
      },
    }),
  };
  try {
    validateRuntimeProfile(converted);
  } catch (error) {
    throw new ExternalAdapterError("external_adapter_runtime_profile_invalid", { cause: error });
  }
  return Object.freeze({
    ...converted,
    command: Object.freeze([...converted.command]),
    ...(converted.lockRecoveryEnvironment ? { lockRecoveryEnvironment: Object.freeze({ ...converted.lockRecoveryEnvironment }) } : {}),
    ...(converted.recoveryCommand ? { recoveryCommand: Object.freeze([...converted.recoveryCommand]) } : {}),
    reservedEnvironment: Object.freeze([...converted.reservedEnvironment]),
    ...(converted.providerEnvironment
      ? { providerEnvironment: Object.freeze({ ...converted.providerEnvironment }) }
      : {}),
    ...(converted.legacyResourcePrefixes
      ? {
        legacyResourcePrefixes: Object.freeze({
          ...converted.legacyResourcePrefixes,
          ...(converted.legacyResourcePrefixes.network ? { network: Object.freeze([...converted.legacyResourcePrefixes.network]) } : {}),
          ...(converted.legacyResourcePrefixes.container ? { container: Object.freeze([...converted.legacyResourcePrefixes.container]) } : {}),
          ...(converted.legacyResourcePrefixes.volume ? { volume: Object.freeze([...converted.legacyResourcePrefixes.volume]) } : {}),
          ...(converted.legacyResourcePrefixes.label ? { label: Object.freeze([...converted.legacyResourcePrefixes.label]) } : {}),
        }),
      }
      : {}),
  });
}

function toEntryExperience(manifest: AppAdapterManifest): EntryExperienceManifest {
  if (manifest.entry.challenge === "oidc") {
    // Core 尚未实现 OIDC 浏览器跳转合同；拒绝加载比把 OIDC 伪装成邮箱
    // 验证码更安全，适配器可在 Core 支持后按版本重新发布。
    throw new ExternalAdapterError("external_adapter_entry_challenge_unsupported");
  }
  return {
    id: normalizeId(manifest.entry.id, "external_adapter_entry_id_invalid"),
    label: manifest.entry.label,
    logoUrl: manifest.entry.logoUrl,
    challenge: manifest.entry.challenge,
    defaultWorkspace: "personal",
    ...(manifest.entry.fields
      ? { fields: manifest.entry.fields.map(toAuthProviderField) }
      : {}),
  };
}

function toStrategyDefinition(
  manifest: AppAdapterManifest,
  profile: NonNullable<AppAdapterManifest["build"]>,
): BuildStrategy {
  const timestamp = new Date(0).toISOString();
  return {
    id: profile.strategyId,
    revision: profile.revision,
    name: manifest.name,
    description: manifest.description,
    runtimeContract: profile.runtimeContract,
    packageRequirements: profile.packageRequirements.map((requirement) => ({
      key: requirement.key,
      required: requirement.required,
      acceptedExtensions: [...requirement.acceptedExtensions],
      ...(requirement.maxBytes === undefined ? {} : { maxBytes: requirement.maxBytes }),
    })),
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function toAuthProviderPlugin(
  provider: AdapterAuthProvider,
  authManifest: AppAdapterManifest["auth"],
  manifest: AppAdapterManifest,
): AuthProviderPlugin {
  const id = normalizeId(provider.id, "external_adapter_auth_provider_invalid");
  const manifestFields = authManifest?.fields?.map(toAuthProviderField) ?? [];
  const providerPresentation = provider.presentation;
  const presentation = providerPresentation
    ? {
      ...providerPresentation,
      ...(providerPresentation.fields === undefined && manifestFields.length > 0
        ? { fields: manifestFields }
        : {}),
    }
    : {
      label: manifest.entry.label,
      iconUrl: manifest.entry.logoUrl,
      challenge: manifest.entry.challenge,
      ...(manifestFields.length > 0 ? { fields: manifestFields } : {}),
    };
  return {
    id,
    // A Provider can be shared by multiple App adapters; the handoff boundary
    // still decides which App may consume each opaque grant.
    scope: "platform",
    create: () => toAuthService(provider, id, presentation),
  };
}

/** 校验公开错误映射，防止 Adapter 返回成功状态或任意异常文本。 */
async function runAuthOperation<T>(provider: AdapterAuthProvider, operation: "email-code" | "login", run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const mapped = provider.mapError?.(error, operation);
    if (!mapped) throw error;
    if (!Number.isInteger(mapped.status) || mapped.status < 400 || mapped.status > 599
      || !/^[a-z][a-z0-9_]{0,127}$/u.test(mapped.code)) {
      throw new ExternalAdapterError("external_adapter_auth_error_mapping_invalid");
    }
    throw new ProviderAuthResponseError(mapped.status, mapped.code);
  }
}

function toAuthService(
  provider: AdapterAuthProvider,
  id: string,
  presentation: NonNullable<AuthService["presentation"]>,
): AuthService {
  return {
    provider: id,
    presentation: { ...presentation, ...(presentation.fields ? { fields: presentation.fields.map((field) => ({ ...field })) } : {}) },
    sendEmailCode: async (email) => normalizeAdapterEmailCodeResult(await runAuthOperation(provider, "email-code", () => provider.sendEmailCode(email))),
    login: async (input: AuthLoginInput) => {
      const result = await runAuthOperation(provider, "login", () => provider.login({
        email: input.email,
        code: input.code,
        ...(input.providerData ? { providerData: input.providerData } : {}),
      }));
      if (!result || !result.identity || result.identity.provider.trim().toLowerCase() !== id) {
        throw new ExternalAdapterError("external_adapter_auth_identity_mismatch");
      }
      if (!result.identity.subject.trim() || !result.identity.email.trim()) {
        throw new ExternalAdapterError("external_adapter_auth_identity_invalid");
      }
      return {
        identity: { ...result.identity, provider: id },
        ...(result.credentialGrant ? { credentialGrant: result.credentialGrant as AuthCredentialGrant } : {}),
      };
    },
    ...(provider.validateCredentialGrant
      ? { validateCredentialGrant: (grant: AuthCredentialGrant) => provider.validateCredentialGrant!(grant as AdapterCredentialGrant) }
      : {}),
    ...(provider.revokeCredentialGrant
      ? { revokeCredentialGrant: (grant: AuthCredentialGrant) => provider.revokeCredentialGrant!(grant as AdapterCredentialGrant) }
      : {}),
    ...(provider.revokeSession
      ? { revokeSession: (refreshToken: string) => provider.revokeSession!(refreshToken) }
      : {}),
  };
}

const PROVIDER_DATA_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const PROVIDER_DATA_MAX_FIELDS = 64;
const PROVIDER_DATA_MAX_STRING_LENGTH = 4_096;
const PROVIDER_DATA_SENSITIVE_KEY_PATTERN = /(?:access|auth|cookie|credential|password|private|refresh|secret|session|token)/iu;
const PROVIDER_DATA_RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type ProviderDataScalar = string | number | boolean | null;

/**
 * Adapter 的历史 challenge 响应可能把产品字段放在顶层。桥接层把这些
 * 字段归一化到 opaque providerData，并过滤凭证形态的值，防止私有响应
 * 结构穿过 Portal HTTP 边界；Core 仍不解释字段语义。
 */
export function normalizeAdapterEmailCodeResult(value: unknown): AuthEmailCodeResult {
  if (value === undefined || value === null) return {};
  if (!isRecordValue(value)) {
    throw new ExternalAdapterError("external_adapter_auth_challenge_invalid");
  }
  const providerData = normalizeProviderData(value.providerData);
  for (const [key, rawValue] of Object.entries(value)) {
    if (key === "providerData" || key === "isNewUser" || key === "ok") continue;
    const scalar = toProviderDataScalar(rawValue);
    if (scalar === undefined) continue;
    addProviderDataValue(providerData, key, scalar);
  }
  const result: AuthEmailCodeResult = {};
  if (Object.keys(providerData).length > 0) result.providerData = providerData;
  if (typeof value.isNewUser === "boolean") result.isNewUser = value.isNewUser;
  return result;
}

function normalizeProviderData(value: unknown): Record<string, ProviderDataScalar> {
  const result: Record<string, ProviderDataScalar> = {};
  if (!isRecordValue(value)) return result;
  for (const [key, rawValue] of Object.entries(value)) {
    const scalar = toProviderDataScalar(rawValue);
    if (scalar === undefined) continue;
    addProviderDataValue(result, key, scalar);
  }
  return result;
}

function addProviderDataValue(
  target: Record<string, ProviderDataScalar>,
  key: string,
  value: ProviderDataScalar,
): void {
  if (Object.keys(target).length >= PROVIDER_DATA_MAX_FIELDS
    || !PROVIDER_DATA_KEY_PATTERN.test(key)
    || PROVIDER_DATA_RESERVED_KEYS.has(key.toLowerCase())
    || PROVIDER_DATA_SENSITIVE_KEY_PATTERN.test(key)
    || target[key] !== undefined) return;
  target[key] = value;
}

function toProviderDataScalar(value: unknown): ProviderDataScalar | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return value.length <= PROVIDER_DATA_MAX_STRING_LENGTH ? value : undefined;
  return undefined;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toAuthProviderField(field: {
  readonly id: string;
  readonly kind: AuthProviderField["kind"];
  readonly label: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly maxLength?: number;
}): AuthProviderField {
  return {
    id: field.id,
    kind: field.kind,
    label: field.label,
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder }),
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.secret === undefined ? {} : { secret: field.secret }),
    ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }),
  };
}

function toAuthHandoff(handoff: AdapterAuthHandoff): AppAuthHandoff {
  const managedCookieNames = validateCookieNames(handoff.managedCookieNames, "external_adapter_handoff_cookie_invalid");
  if (new Set(managedCookieNames.map((name) => name.toLowerCase())).size !== managedCookieNames.length) {
    throw new ExternalAdapterError("external_adapter_handoff_cookie_invalid");
  }
  return {
    appId: handoff.appId.trim().toLowerCase(),
    managedCookieNames,
    onLogin: async (input: AppAuthLoginInput) => sanitizeSetCookies(await handoff.onLogin(toAdapterLoginInput(input))),
    onLogout: async (input: AppAuthLogoutInput) => sanitizeSetCookies(await handoff.onLogout(toAdapterLogoutInput(input))),
    proxyOptions: (input: AppAuthProxyInput) => sanitizeProxyOptions(handoff.proxyOptions(input), input.secureCookies),
    ...(handoff.acceptsCredentialGrant
      ? { acceptsCredentialGrant: (grant: AuthCredentialGrant) => handoff.acceptsCredentialGrant!(grant as AdapterCredentialGrant) }
      : {}),
    ...(handoff.hasSession ? { hasSession: (cookieHeader: string | undefined) => handoff.hasSession!(cookieHeader) } : {}),
  };
}

function toAdapterLoginInput(input: AppAuthLoginInput): AppAuthLoginInput & {
  credentialGrant?: AdapterCredentialGrant;
  revokeCredentialGrant?: (grant: AdapterCredentialGrant, reason: AdapterAuthRevocationReason) => Promise<void>;
} {
  return {
    ...input,
    ...(input.credentialGrant ? { credentialGrant: input.credentialGrant as AdapterCredentialGrant } : {}),
    ...(input.revokeCredentialGrant
      ? { revokeCredentialGrant: (grant: AdapterCredentialGrant, reason: AdapterAuthRevocationReason) => input.revokeCredentialGrant!(grant as AuthCredentialGrant, reason) }
      : {}),
  } as AppAuthLoginInput & {
    credentialGrant?: AdapterCredentialGrant;
    revokeCredentialGrant?: (grant: AdapterCredentialGrant, reason: AdapterAuthRevocationReason) => Promise<void>;
  };
}

function toAdapterLogoutInput(input: AppAuthLogoutInput): AdapterAuthLogoutInput {
  return {
    ...input,
    ...(input.revokeCredentialGrant
      ? { revokeCredentialGrant: (grant: AdapterCredentialGrant, reason: AdapterAuthRevocationReason) => input.revokeCredentialGrant!(grant as AuthCredentialGrant, reason) }
      : {}),
  };
}

function sanitizeSetCookies(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values) || values.length > 128) throw new ExternalAdapterError("external_adapter_handoff_response_invalid");
  return values.map((value) => {
    const separator = typeof value === "string" ? value.indexOf("=") : -1;
    const name = separator > 0 ? value.slice(0, separator).trim() : "";
    if (typeof value !== "string" || !value || value.length > 16_384 || /[\r\n]/u.test(value)
      || !COOKIE_NAME_PATTERN.test(name)) {
      throw new ExternalAdapterError("external_adapter_handoff_response_invalid");
    }
    return value;
  });
}

function sameBuildProfile(
  left: NonNullable<AppAdapterManifest["build"]>,
  right: AppAdapterManifest["build"] | undefined,
): boolean {
  if (!right) return false;
  return left.strategyId === right.strategyId
    && left.revision === right.revision
    && left.runtimeContract === right.runtimeContract
    && left.imagePrefix === right.imagePrefix
    && JSON.stringify(left.packageRequirements) === JSON.stringify(right.packageRequirements);
}

function sameCookieNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightNames = new Set(right.map((name) => name.trim().toLowerCase()));
  return left.every((name) => rightNames.has(name.trim().toLowerCase()));
}

function selectFactory(namespace: Record<string, unknown>): OpenAppAdapterFactory {
  const candidates = [
    namespace.default,
    namespace.openAppAdapterFactory,
    namespace.createOpenAppAdapter,
    namespace.createAdapter,
  ];
  const factory = candidates.find((candidate): candidate is OpenAppAdapterFactory => typeof candidate === "function");
  if (!factory) throw new ExternalAdapterError("external_adapter_factory_missing");
  return factory;
}

async function normalizeModuleSpecifier(
  value: string,
  approvedModuleRoots?: readonly string[],
  approvedPackageSpecifiers?: readonly string[],
): Promise<string> {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw || raw.length > 512 || /[\0\r\n]/u.test(raw)) throw new ExternalAdapterError("external_adapter_module_invalid");
  if (raw.startsWith("file:")) {
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new ExternalAdapterError("external_adapter_module_invalid"); }
    if (parsed.protocol !== "file:" || parsed.search || parsed.hash) throw new ExternalAdapterError("external_adapter_module_invalid");
    const path = decodeFilePath(parsed);
    const approvedPath = await assertApprovedModulePath(path, approvedModuleRoots);
    return pathToFileURL(approvedPath).href;
  }
  if (isAbsolute(raw)) {
    const path = resolve(raw);
    const approvedPath = await assertApprovedModulePath(path, approvedModuleRoots);
    return pathToFileURL(approvedPath).href;
  }
  if (raw.startsWith(".") || raw.includes("\\")) {
    const path = resolve(process.cwd(), raw);
    const approvedPath = await assertApprovedModulePath(path, approvedModuleRoots);
    return pathToFileURL(approvedPath).href;
  }
  if (!/^(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(?:\/[a-z0-9._~-]+)*$/iu.test(raw)) {
    throw new ExternalAdapterError("external_adapter_module_invalid");
  }
  if (approvedPackageSpecifiers !== undefined && !approvedPackageSpecifiers.includes(raw)) {
    throw new ExternalAdapterError("external_adapter_module_not_approved");
  }
  return raw;
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HOST_PATTERN = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252}[A-Za-z0-9])?)(?::\d{1,5})?$/u;
const PROXY_OPTION_KEYS = new Set([
  "upstreamHost",
  "upstreamHeaders",
  "stripRequestCookies",
  "stripCookieNames",
  "stripResponseCookieNames",
  "rootScopedCookieNames",
  "httpOnlyRootScopedCookieNames",
  "secureRootScopedCookies",
]);
const BLOCKED_UPSTREAM_HEADERS = new Set([
  "connection",
  "content-length",
  "cookie",
  "host",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-openapp-admin-token",
]);

function sanitizeProxyOptions(value: unknown, secureCookies: boolean): import("./proxy.js").ProxyOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !PROXY_OPTION_KEYS.has(key))) {
    throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
  }
  const upstreamHost = candidate.upstreamHost === undefined
    ? undefined
    : validateUpstreamHost(candidate.upstreamHost);
  const upstreamHeaders = candidate.upstreamHeaders === undefined
    ? undefined
    : validateUpstreamHeaders(candidate.upstreamHeaders);
  const stripRequestCookies = candidate.stripRequestCookies === undefined
    ? undefined
    : validateBoolean(candidate.stripRequestCookies);
  const secureRootScopedCookies = candidate.secureRootScopedCookies === undefined
    ? secureCookies
    : validateBoolean(candidate.secureRootScopedCookies) || secureCookies;
  return {
    ...(upstreamHost === undefined ? {} : { upstreamHost }),
    ...(upstreamHeaders === undefined ? {} : { upstreamHeaders }),
    ...(stripRequestCookies === undefined ? {} : { stripRequestCookies }),
    ...validateCookieListOption(candidate.stripCookieNames, "stripCookieNames"),
    ...validateCookieListOption(candidate.stripResponseCookieNames, "stripResponseCookieNames"),
    ...validateCookieListOption(candidate.rootScopedCookieNames, "rootScopedCookieNames"),
    ...validateCookieListOption(candidate.httpOnlyRootScopedCookieNames, "httpOnlyRootScopedCookieNames"),
    secureRootScopedCookies,
  };
}

function validateUpstreamHost(value: unknown): string {
  if (typeof value !== "string") throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
  const host = value.trim();
  if (!host || host.length > 255 || !HOST_PATTERN.test(host)) {
    throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
  }
  const portSeparator = host.lastIndexOf(":");
  if (portSeparator > 0 && !host.endsWith("]")) {
    const port = Number(host.slice(portSeparator + 1));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
    }
  }
  return host;
}

function validateUpstreamHeaders(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
  const result: Record<string, string> = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    const normalized = name.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || BLOCKED_UPSTREAM_HEADERS.has(normalized)
      || typeof rawValue !== "string" || rawValue.length > 4_096 || /[\0-\x1f\x7f]/u.test(rawValue)) {
      throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
    }
    result[name] = rawValue;
  }
  return result;
}

function validateCookieListOption(
  value: unknown,
  key: string,
): Record<string, readonly string[]> {
  if (value === undefined) return {};
  return { [key]: validateCookieNames(value, "external_adapter_proxy_options_invalid") };
}

function validateCookieNames(value: unknown, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || !COOKIE_NAME_PATTERN.test(item))) {
    throw new ExternalAdapterError(code);
  }
  return value.map((item) => (item as string).trim());
}

function validateBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new ExternalAdapterError("external_adapter_proxy_options_invalid");
  return value;
}

function decodeFilePath(url: URL): string {
  try {
    const path = decodeURIComponent(url.pathname);
    if (!path || path.includes("\0")) throw new Error("invalid path");
    return resolve(path);
  } catch {
    throw new ExternalAdapterError("external_adapter_module_invalid");
  }
}

async function assertApprovedModulePath(path: string, approvedRoots?: readonly string[]): Promise<string> {
  const normalizedPath = resolve(path);
  if (approvedRoots === undefined) return normalizedPath;
  // Resolve both sides before comparing. A lexical check would allow an
  // approved directory to contain a symlink that loads code from elsewhere.
  const canonicalPath = await realpathOrResolved(normalizedPath);
  const roots = await Promise.all(approvedRoots.map((root) => realpathOrResolved(resolve(root))));
  if (!roots.some((root) => {
    const child = relative(root, canonicalPath);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  })) {
    throw new ExternalAdapterError("external_adapter_module_not_approved");
  }
  return canonicalPath;
}

async function realpathOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    // Preserve the old import error for a missing module while still using
    // canonical paths whenever the selected file or root exists.
    if (error && typeof error === "object" && "code" in error
      && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return resolve(path);
    }
    throw new ExternalAdapterError("external_adapter_module_not_approved", { cause: error });
  }
}

function normalizeId(value: unknown, code: string): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) throw new ExternalAdapterError(code);
  return normalized;
}

function defaultReleaseInspector(): AdapterReleaseInspector {
  // 旧 Host 字段仅为协议兼容保留；具体包格式必须由 Adapter 实现。
  const unavailable = async (): Promise<never> => { throw new ExternalAdapterError("adapter_release_inspector_missing"); };
  return { inspectUpload: unavailable };
}
