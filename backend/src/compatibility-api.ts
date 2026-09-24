/**
 * 外部应用 Adapter 的公开兼容合同。
 * Core 只导出数据端口；旧路由、认证、投影和迁移证据由外部 Adapter
 * 经 external-adapter 装载。本模块不能引入任何产品实现。
 */
export type {
  AdapterAuthHandoff,
  AdapterAuthProvider,
  AdapterCompatibility,
  AdapterLegacyIntegration,
  AdapterMigrationPlan,
  AdapterRuntimeProfile,
  LegacyCatalogAdapter,
  LegacyMigrationAdapter,
  LegacyProjectionAdapter,
  LegacyRouteAliases,
} from "@openapp/contracts";

export {
  validateAdapterCompatibility,
  validateAdapterLegacy,
} from "@openapp/contracts";

export {
  createLegacyCompatibilityHost,
  createLegacyPortalCompatibilityBoundary,
  createAdapterLegacyCompatibilityBoundary,
} from "./legacy-host.js";
export type {
  LegacyCompatibilityHost,
  LegacyCompatibilityHostOptions,
} from "./legacy-host.js";
