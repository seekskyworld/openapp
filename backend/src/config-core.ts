/**
 * 与产品无关的 Portal 配置解析器。
 *
 * 该模块只认识 OpenApp 平台配置和由调用方传入的默认值；历史产品变量
 * 由外部 Adapter 先解析后通过 defaults 注入，避免通用组合根加载旧协议。
 */
import { resolve } from "node:path";
import { normalizeMcpAppSandboxOrigin } from "@openapp/container-runtime";
import { GENERIC_AUTH_PROVIDER, GENERIC_SESSION_COOKIE_NAME } from "./config-defaults.js";

export type AuthProviderId = string;

export interface PortalConfig {
  /** 仅运行平台账户和管理读取，不加载应用插件或执行工作负载任务。 */
  readonly controlPlaneOnly?: boolean;
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly authMode: AuthProviderId;
  readonly authProvider: AuthProviderId;
  /** 通用身份 Provider 的地址；具体协议由已注册 Provider 负责。 */
  readonly authProviderBaseUrl?: string;
  readonly managedAuthCookieNames?: readonly string[];
  readonly adminCliToken: string;
  readonly cookieName: string;
  readonly secureCookies: boolean;
  readonly trustProxy: boolean;
  readonly sessionTtlHours: number;
  readonly publicBaseUrl: string;
  readonly mcpAppSandboxOrigin?: string;
  readonly allowedOrigins: readonly string[];
  readonly staticDir: string;
  readonly releaseDir: string;
}

export interface GenericConfigDefaults {
  readonly authProvider?: string;
  readonly authProviderBaseUrl?: string;
  readonly sessionCookieName?: string;
  readonly additionalAuthProviderBaseUrls?: readonly (string | undefined)[];
  readonly additionalAuthCookieNames?: readonly (string | undefined)[];
}

/**
 * 解析通用配置。所有产品特定别名必须通过 defaults 显式传入，且不会从
 * 请求、数据库或当前工作目录推断。
 */
export function loadGenericConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaults: GenericConfigDefaults = {},
): PortalConfig {
  return loadConfigForDefaults(env, {
    authProvider: defaults.authProvider ?? GENERIC_AUTH_PROVIDER,
    authProviderBaseUrl: defaults.authProviderBaseUrl,
    sessionCookieName: defaults.sessionCookieName ?? GENERIC_SESSION_COOKIE_NAME,
    additionalAuthProviderBaseUrls: defaults.additionalAuthProviderBaseUrls,
    additionalAuthCookieNames: defaults.additionalAuthCookieNames,
  });
}

export function loadConfigForDefaults(
  env: NodeJS.ProcessEnv,
  defaults: Required<Pick<GenericConfigDefaults, "authProvider" | "sessionCookieName">>
    & Omit<GenericConfigDefaults, "authProvider" | "sessionCookieName">,
): PortalConfig {
  const requestedAuthProvider = env.AUTH_PROVIDER?.trim();
  const authProvider = requestedAuthProvider && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(requestedAuthProvider)
    ? requestedAuthProvider
    : defaults.authProvider;
  const authProviderBaseUrlValue = firstConfigured(
    env.OPENAPP_AUTH_PROVIDER_BASE_URL,
    env.AUTH_PROVIDER_BASE_URL,
    ...(defaults.additionalAuthProviderBaseUrls ?? []),
  );
  const authProviderBaseUrl = authProviderBaseUrlValue
    ? normalizeBaseUrl(authProviderBaseUrlValue)
    : (defaults.authProviderBaseUrl ? normalizeBaseUrl(defaults.authProviderBaseUrl) : undefined);
  const publicBaseUrl = normalizeBaseUrl(env.PORTAL_PUBLIC_BASE_URL ?? "http://127.0.0.1:4310");
  const cookieName = env.SESSION_COOKIE?.trim() || defaults.sessionCookieName;
  const managedAuthCookieNames = splitList(firstConfigured(
    env.OPENAPP_AUTH_COOKIE_NAMES,
    env.AUTH_COOKIE_NAMES,
    ...(defaults.additionalAuthCookieNames ?? []),
  ));
  if (!isValidCookieName(cookieName) || managedAuthCookieNames.some((name) => name === cookieName)) {
    throw new Error("SESSION_COOKIE must be a valid, non-reserved cookie name");
  }
  return {
    host: env.HOST?.trim() || "127.0.0.1",
    controlPlaneOnly: parseBoolean(env.OPENAPP_CONTROL_PLANE_ONLY, false),
    port: parseInteger(env.PORT, 4310, "PORT", 1, 65_535),
    databaseUrl: databaseUrlFromEnv(env),
    authMode: authProvider,
    authProvider,
    ...(authProviderBaseUrl ? { authProviderBaseUrl } : {}),
    managedAuthCookieNames,
    adminCliToken: env.OPENAPP_ADMIN_CLI_TOKEN?.trim() || "",
    cookieName,
    secureCookies: new URL(publicBaseUrl).protocol === "https:" || parseBoolean(env.SESSION_COOKIE_SECURE, false),
    trustProxy: parseBoolean(env.PORTAL_TRUST_PROXY, false),
    sessionTtlHours: parseInteger(env.SESSION_TTL_HOURS, 168, "SESSION_TTL_HOURS", 1, 24 * 365),
    publicBaseUrl,
    mcpAppSandboxOrigin: normalizeMcpAppSandboxOrigin(env.MCP_APP_SANDBOX_ORIGIN),
    allowedOrigins: splitList(env.PORTAL_ALLOWED_ORIGINS ?? "http://127.0.0.1:4174,http://localhost:4174"),
    staticDir: resolve(env.PORTAL_STATIC_DIR?.trim() || "../frontend/dist"),
    releaseDir: resolve(env.OPENAPP_RELEASE_DIR?.trim() || "/var/lib/openapp/releases"),
  };
}

function databaseUrlFromEnv(env: NodeJS.ProcessEnv): string {
  const explicit = env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  if (env.POSTGRES_PASSWORD === undefined) return "";

  const host = env.POSTGRES_HOST?.trim() || "127.0.0.1";
  const port = env.POSTGRES_PORT?.trim() || "5432";
  const user = env.POSTGRES_USER?.trim() || "container_service";
  const database = env.POSTGRES_DB?.trim() || "container_service";
  if (!host || !user || !database || !/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("POSTGRES_HOST, POSTGRES_PORT, POSTGRES_USER and POSTGRES_DB must describe a valid database endpoint");
  }
  const hostPart = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(env.POSTGRES_PASSWORD)}@${hostPart}:${port}/${encodeURIComponent(database)}`;
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, "");
  const parsed = new URL(normalized);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${value} must be an HTTP(S) URL`);
  }
  return normalized;
}

function splitList(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}

function firstConfigured(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim();
}

function isValidCookieName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  throw new Error(`${value} must be true or false`);
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = value?.trim() ? Number(value) : fallback;
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}
