import type { RuntimeProfile } from "./runtime-profile.js";

/** 通用 Runtime 的保留环境变量；产品专用变量由 Adapter 自己注入且不会被请求覆盖。 */
export const RUNTIME_RESERVED_ENVIRONMENT = new Set([
  "OPENAPP_CONFIG_FILES_JSON",
]);

/** 策略写入和容器执行共用同一精确保留集合，包含所有运行时自动注入的键。 */
export function runtimeReservedEnvironmentNames(profile: RuntimeProfile): ReadonlySet<string> {
  return new Set([
    ...RUNTIME_RESERVED_ENVIRONMENT,
    ...profile.reservedEnvironment,
    profile.configEnvironmentKey,
    ...Object.values(profile.lockRecoveryEnvironment ?? {}),
    ...(profile.providerEnvironment?.authProviderKey ? [profile.providerEnvironment.authProviderKey] : []),
    ...(profile.providerEnvironment?.allowedOriginsKey ? [profile.providerEnvironment.allowedOriginsKey] : []),
    ...(profile.providerEnvironment?.mcpAppSandboxOriginKey ? [profile.providerEnvironment.mcpAppSandboxOriginKey] : []),
  ]);
}

/**
 * 只保护 Core 自有键和当前 Adapter 声明的精确键名，不按应用变量后缀推测用途。
 */
export function isRuntimeReservedEnvironmentName(
  name: string,
  options: { additionalReserved?: ReadonlySet<string> } = {},
): boolean {
  return RUNTIME_RESERVED_ENVIRONMENT.has(name)
    || options.additionalReserved?.has(name) === true;
}

export function normalizeMcpAppSandboxOrigin(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const parsed = new URL(value.trim());
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("MCP_APP_SANDBOX_ORIGIN must be an HTTP(S) origin without a path, query or fragment");
  }
  return parsed.origin;
}
