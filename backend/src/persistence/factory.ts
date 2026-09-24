/**
 * 通用持久化组合工厂。该模块只依赖 Persistence 合同和通用适配器，不能
 * 引入任何具体 App 的策略、认证或运行时兼容实现。
 */
import type { BuildStrategy } from "../models.js";
import { provisioningPolicyFromDefaults, type ProvisioningPolicy, type ProvisioningPolicyDefaults } from "../instance-policy.js";
import type { PortalConfig } from "../config-core.js";
import type { AuthProviderId } from "../auth/types.js";
import type { Persistence, PersistenceCompatibilityDefaults } from "./contracts.js";
import { MemoryPersistence } from "./memory.js";
import { PostgresPersistence } from "./postgres.js";

export interface ConfiguredPersistenceOptions {
  /** @deprecated 保留旧组合调用；不再触发产品默认值推断。 */
  readonly legacyCompatibility?: boolean;
  /** @deprecated 使用 compatibilityDefaults.authProvider。 */
  readonly defaultAuthProvider?: AuthProviderId | "local";
  readonly compatibilityDefaults?: PersistenceCompatibilityDefaults;
  readonly strategyDefinitions?: readonly BuildStrategy[];
  readonly provisioningPolicyFallback?: ProvisioningPolicy;
  readonly provisioningPolicyDefaults?: ProvisioningPolicyDefaults;
}

/** 根据部署配置创建一个明确选择过模式的持久化适配器。 */
export function createConfiguredPersistence(
  portalConfig: Pick<PortalConfig, "databaseUrl">,
  options: ConfiguredPersistenceOptions = {},
): Persistence {
  // 将 Adapter 的部分默认值在组合边界补全为显式 fallback。持久化适配器
  // 只在目标策略行不存在时使用它，已有数据库行始终优先。
  const configuredDefaultAppId = options.provisioningPolicyDefaults?.defaultAppId;
  const provisioningPolicyFallback = typeof configuredDefaultAppId === "string" && configuredDefaultAppId.trim() !== ""
    ? provisioningPolicyFromDefaults(options.provisioningPolicyDefaults!)
    : options.provisioningPolicyFallback;
  const compatibilityDefaults = {
    ...(options.compatibilityDefaults?.authProvider !== undefined
      ? { authProvider: options.compatibilityDefaults.authProvider }
      : options.defaultAuthProvider !== undefined
        ? { authProvider: options.defaultAuthProvider }
        : {}),
    ...(options.compatibilityDefaults?.appId !== undefined
      ? { appId: options.compatibilityDefaults.appId }
      : configuredDefaultAppId !== undefined && configuredDefaultAppId.trim() !== ""
        ? { appId: configuredDefaultAppId }
        : {}),
  } satisfies PersistenceCompatibilityDefaults;
  const persistenceOptions = {
    ...(options.legacyCompatibility === undefined ? {} : { legacyCompatibility: options.legacyCompatibility }),
    ...(Object.keys(compatibilityDefaults).length === 0 ? {} : { compatibilityDefaults }),
    ...(options.strategyDefinitions === undefined ? {} : { strategyDefinitions: options.strategyDefinitions }),
    ...(provisioningPolicyFallback === undefined ? {} : { provisioningPolicyFallback }),
  };
  const persistence = portalConfig.databaseUrl
    ? new PostgresPersistence(portalConfig.databaseUrl, persistenceOptions)
    : new MemoryPersistence(persistenceOptions);
  return persistence;
}
