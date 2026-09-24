import type { ProviderHealthStatus } from "./provider-observability.js";

/**
 * Portal 与历史部署之间的最小防腐层。
 *
 * Core 只知道旧合同是否存在以及如何投影结果，不知道具体产品、Provider
 * 或 Cookie 名称。兼容实现由组合根显式注入；通用组合使用本文件的空实现。
 */
export interface PortalCompatibilityBoundary {
  readonly mode: "generic" | "legacy";
  readonly projectEmailCodeResponse?: (providerId: string, value: unknown) => Readonly<Record<string, unknown>>;
  /** 解析旧入口路径；通用模式始终返回 undefined。 */
  resolveAuthRoute(pathname: string): PortalCompatibilityAuthRoute | undefined;
  /** 判断某个路径是否属于 Adapter 声明的旧认证命名空间。 */
  readonly isAuthNamespacePath?: (pathname: string) => boolean;
  /** 将通用管理配置投影为旧控制台需要的附加字段。 */
  projectAdminConfig(input: PortalCompatibilityAdminConfigInput): Readonly<Record<string, unknown>>;
  /** 将 Provider 健康状态投影为旧 runtime 字段，通用模式原样返回。 */
  projectRuntimeStatus(status: ProviderHealthStatus): unknown;
  /** 检查部署是否配置了当前组合允许的运行时镜像变量。 */
  isRuntimeImageConfigured(environment: NodeJS.ProcessEnv): boolean;
  /** 兼容旧部署暂存文件的命名规则；通用组合不提供该配置。 */
  readonly uploadArtifactCleanup?: PortalUploadArtifactCleanupProfile;
}

export interface PortalUploadArtifactCleanupProfile {
  readonly imageTemporaryPrefixes?: readonly string[];
  readonly releaseArtifactMatchers?: readonly RegExp[];
}

export interface PortalCompatibilityAuthRoute {
  readonly operation: "email-code" | "login";
  readonly providerId: string;
}

export interface PortalCompatibilityAdminConfigInput {
  readonly authProvider: string;
  readonly authProviderBaseUrl?: string;
  readonly runtimeImageConfigured: boolean;
}

export const GENERIC_PORTAL_COMPATIBILITY_BOUNDARY: PortalCompatibilityBoundary = Object.freeze({
  mode: "generic",
  resolveAuthRoute: () => undefined,
  // 旧 SSO 命名空间是协议形状而不是某个产品身份。即使当前 App 没有
  // legacy Adapter，也必须在认证层之前 fail closed，避免把旧路径误当成
  // 通用登录接口并泄露 Provider 是否存在。
  isAuthNamespacePath: (pathname: string) => {
    const normalized = pathname.trim().replace(/\/+$/u, "") || "/";
    return normalized === "/api/auth/sso" || normalized.startsWith("/api/auth/sso/");
  },
  projectAdminConfig: () => ({}),
  projectRuntimeStatus: (status: ProviderHealthStatus) => status,
  isRuntimeImageConfigured: (environment: NodeJS.ProcessEnv) => Boolean(
    environment.OPENAPP_RUNTIME_IMAGE?.trim(),
  ),
});
