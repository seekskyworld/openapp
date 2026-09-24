/**
 * 旧数据库的通用迁移入口。
 *
 * 迁移命令只负责装载部署选择的 Adapter、校验其迁移证据并调用
 * Persistence.initialize。Adapter 不得把 SQL、shell 或网络动作注入 Core；
 * 已有表和行始终由 Persistence 以幂等加法方式保留。
 */
import { pathToFileURL } from "node:url";
import { loadGenericConfig, type PortalConfig } from "./config-core.js";
import { DockerArtifactAdapter, type OciArtifactManagementPort } from "./artifact-provider.js";
import { createContainerRuntime, type ContainerRuntime } from "./runtime.js";
import {
  loadConfiguredAppPlugins,
  resolveCompositionAuthProvider,
} from "./portal-context-core.js";
import { PlatformPluginRegistry, type AppIntegrationPlugin } from "./platform-plugins.js";
import { createConfiguredPersistence } from "./persistence/factory.js";
import type { Persistence } from "./persistence/contracts.js";
import type { AdapterMigrationPlan } from "@openapp/contracts";
import type { BuildCommandRunner } from "./build-strategies.js";
import type { AdapterReleaseInspector } from "@openapp/contracts";
import { GENERIC_RUNTIME_PROFILE } from "@openapp/container-runtime";

export interface LegacyMigrationOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly config?: PortalConfig;
  readonly runtime?: ContainerRuntime;
  readonly artifacts?: OciArtifactManagementPort;
  readonly persistence?: Persistence;
  readonly appId?: string;
  readonly adapterId?: string;
  /** 默认 true；仅旧离线回切可显式关闭。 */
  readonly requireExternalAdapter?: boolean;
  readonly releaseInspector?: AdapterReleaseInspector;
  readonly runCommand?: BuildCommandRunner;
}

export interface LegacyMigrationResult {
  readonly appId: string;
  readonly plan?: AdapterMigrationPlan;
  readonly strategyCount: number;
  readonly persistence: "injected" | "configured";
}

/**
 * 在一个指定的数据库连接上执行 legacy schema 初始化。函数不会删除表、行、
 * 发布包或 Volume；调用方可以注入 Persistence 以在隔离测试中验证参数。
 */
export async function migrateLegacy(
  options: LegacyMigrationOptions = {},
): Promise<LegacyMigrationResult> {
  const environment = { ...(options.environment ?? process.env) };
  const config = options.config ?? loadGenericConfig(environment);
  const runtime = options.runtime ?? (options.artifacts ? undefined : createContainerRuntime({
    compatibilityMode: true,
    environment,
    // 迁移只需要一个无副作用的构建端口；真正的 legacy Runtime profile
    // 在 Portal 组合时由 Adapter 装载，不能在迁移发现阶段猜测产品值。
    profile: GENERIC_RUNTIME_PROFILE,
  }));
  const artifacts = options.artifacts ?? new DockerArtifactAdapter(runtime!);
  const plugins = await loadConfiguredAppPlugins({
    artifacts,
    config,
    environment,
    ...(options.appId === undefined ? {} : { expectedAppId: options.appId }),
    ...(options.adapterId === undefined ? {} : { expectedAdapterId: options.adapterId }),
    ...(options.releaseInspector === undefined ? {} : { releaseInspector: options.releaseInspector }),
    ...(options.runCommand === undefined ? {} : { runCommand: options.runCommand }),
    requireExternalAdapter: options.requireExternalAdapter ?? true,
  });
  const registry = new PlatformPluginRegistry(plugins);
  const appId = resolveMigrationAppId(options.appId, environment, plugins);
  const plan = registry.migrationPlanForApp(appId)
    ?? registry.legacyMigrationForApp(appId)?.plan;
  if (!plan) throw new Error("legacy_migration_plan_required");
  // 当前 Core 的 Persistence 端口只提供幂等的加法式 schema 初始化；它不会
  // 执行 Adapter 的纯 transform 函数或猜测输入数据。未来支持转换时必须先
  // 增加带版本和回滚语义的专用端口，不能把 transform 静默当成 additive。
  if (plan.strategy !== "additive") throw new Error("legacy_migration_strategy_unsupported");
  const authProviderId = resolveCompositionAuthProvider(config, plugins, environment);
  const selectedConfig = authProviderId === config.authProvider
    ? config
    : { ...config, authMode: authProviderId, authProvider: authProviderId };
  const policyDefaults = registry.provisioningPolicyDefaults();
  const strategyDefinitions = registry.buildStrategyDefinitions();
  const persistence = options.persistence ?? createConfiguredPersistence(selectedConfig, {
    legacyCompatibility: true,
    compatibilityDefaults: {
      authProvider: authProviderId,
      appId,
    },
    strategyDefinitions,
    provisioningPolicyDefaults: policyDefaults,
  });
  try {
    await persistence.initialize({
      ...(Object.keys(registry.legacyPackageColumns()).length ? { legacyPackageColumns: registry.legacyPackageColumns() } : {}),
      legacyCompatibility: true,
      compatibilityDefaults: {
        authProvider: authProviderId,
        appId,
      },
      strategyDefinitions,
      provisioningPolicyDefaults: policyDefaults,
    });
    if (plan) {
      console.log(
        `legacy migration ready: ${plan.id} (${plan.fromSchema} -> ${plan.toSchema}, ${plan.strategy})`,
      );
    }
    return {
      appId,
      plan,
      strategyCount: strategyDefinitions.length,
      persistence: options.persistence ? "injected" : "configured",
    };
  } finally {
    if (!options.persistence) await persistence.close?.();
  }
}

function resolveMigrationAppId(
  requested: string | undefined,
  environment: NodeJS.ProcessEnv,
  plugins: readonly AppIntegrationPlugin[],
): string {
  const value = requested?.trim()
    || environment.OPENAPP_APP_ID?.trim()
    || (plugins.length === 1 ? plugins[0]?.appId : undefined);
  if (!value) throw new Error("legacy_migration_app_selection_required");
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error("legacy_migration_app_id_invalid");
  }
  if (!plugins.some((plugin) => plugin.appId.trim().toLowerCase() === normalized)) {
    throw new Error("legacy_migration_app_not_loaded");
  }
  return normalized;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateLegacy().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
