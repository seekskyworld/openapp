/**
 * 通用 OpenApp 组合根入口。该模块只加载 Core 与外部 Adapter loader，不
 * 引入 legacy facade，确保服务端启动图与兼容实现保持单向依赖。
 */
export {
  createPortalContextAsync,
  createPortalContext,
  loadConfiguredAppPlugins,
} from "./portal-context-core.js";
export type {
  PortalContext,
  PortalContextOptions,
  ConfiguredAppPluginsOptions,
  PortalExecutionProvider,
} from "./portal-context-core.js";
