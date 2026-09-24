/**
 * 通用认证公共入口。这里仅暴露 Provider-neutral 合同；
 * Provider、Cookie handoff 及旧字段投影必须从显式 compat 入口加载，避免新 App
 * 通过一个 barrel 误依赖某个历史产品。
 */
export { createGenericAuthService } from "./core.js";
export type { GenericAuthConfig } from "./core.js";
export { AuthProviderRegistry } from "./provider-registry.js";
export type {
  AuthProviderRegistryOptions,
  ExternalAuthProviderDescription,
} from "./provider-registry.js";
export type {
  AuthCredentialGrant,
  AuthEmailCodeResult,
  AuthIdentity,
  AuthLoginInput,
  AuthLoginResult,
  AuthProvider,
  AuthProviderData,
  AuthProviderField,
  AuthProviderFieldKind,
  AuthProviderId,
  AuthProviderPresentation,
  AuthService,
} from "./types.js";
