import {
  validateAdapterLegacy,
  type AdapterLegacyIntegration,
  type LegacyMigrationAdapter,
} from "@openapp/contracts";
import type {
  PortalCompatibilityAdminConfigInput,
  PortalCompatibilityAuthRoute,
  PortalCompatibilityBoundary,
  PortalUploadArtifactCleanupProfile,
} from "./portal-compatibility.js";
import type { ProviderHealthStatus } from "./provider-observability.js";

/**
 * 通用 Core 对外部兼容岛的最小宿主。宿主只处理已校验的路由、纯数据投影和
 * 迁移证据，不加载产品模块，也不向 Adapter 暴露请求、数据库或运行时客户端。
 */
export interface LegacyCompatibilityHost {
  projectEmailCodeResponse(providerId: string, value: unknown): Readonly<Record<string, unknown>>;
  resolveAuthRoute(pathname: string): PortalCompatibilityAuthRoute | undefined;
  isAuthNamespacePath(pathname: string): boolean;
  projectApp(value: unknown): unknown;
  projectAdminConfig(input: PortalCompatibilityAdminConfigInput): Readonly<Record<string, unknown>>;
  projectRuntimeStatus(status: ProviderHealthStatus): unknown;
  isRuntimeImageConfigured(environment: NodeJS.ProcessEnv): boolean;
  migrationForApp(): LegacyMigrationAdapter | undefined;
}

export interface LegacyCompatibilityHostOptions {
  /** Adapter compatibility 清单中声明的镜像环境变量别名。 */
  readonly runtimeImageEnvironmentKeys?: readonly string[];
  /** 仅由显式兼容组合提供的旧上传清理命名规则。 */
  readonly uploadArtifactCleanup?: PortalUploadArtifactCleanupProfile;
}

/**
 * 构造一个只依赖公开合同的兼容宿主。传入值会再次校验，便于测试或其他
 * 组合根直接使用；Core 不信任外部模块在注册后继续修改合同对象。
 */
export function createLegacyCompatibilityHost(
  value: AdapterLegacyIntegration,
  options: LegacyCompatibilityHostOptions = {},
): LegacyCompatibilityHost {
  const legacy = validateAdapterLegacy(value);
  const authRoutes = collectAuthRoutes(legacy);
  const authNamespaces = collectAuthNamespaces(legacy);
  const providerId = normalizeProviderId(legacy.auth?.providerId ?? legacy.auth?.provider?.id);
  const imageEnvironmentKeys = collectImageEnvironmentKeys(legacy, options.runtimeImageEnvironmentKeys);

  return {
    projectEmailCodeResponse(selectedProviderId: string, value: unknown): Readonly<Record<string, unknown>> {
      if (selectedProviderId !== providerId) return Object.freeze({});
      const projector = legacy.projection?.projectEmailCodeResponse;
      return freezeRecord(projector ? projector(cloneData(value)) : {});
    },
    resolveAuthRoute(pathname: string): PortalCompatibilityAuthRoute | undefined {
      const normalizedPath = normalizePathname(pathname);
      if (!normalizedPath || !authRoutes.has(normalizedPath) || !providerId) return undefined;
      const operation = routeOperation(normalizedPath);
      return operation ? { operation, providerId } : undefined;
    },
    isAuthNamespacePath(pathname: string): boolean {
      const normalizedPath = normalizePathname(pathname);
      if (!normalizedPath) return false;
      return [...authNamespaces].some((prefix) => (
        normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
      ));
    },
    projectApp(value: unknown): unknown {
      const projector = legacy.projection?.projectApp;
      return freezeData(projector ? projector(cloneData(value)) : cloneData(value));
    },
    projectAdminConfig(input: PortalCompatibilityAdminConfigInput): Readonly<Record<string, unknown>> {
      const projector = legacy.projection?.projectAdminConfig;
      if (!projector) return Object.freeze({});
      const projected = projector(cloneData(input));
      return freezeRecord(projected);
    },
    projectRuntimeStatus(status: ProviderHealthStatus): unknown {
      const projector = legacy.projection?.projectRuntimeStatus;
      return freezeData(projector ? projector(cloneData(status)) : cloneData(status));
    },
    isRuntimeImageConfigured(environment: NodeJS.ProcessEnv): boolean {
      return imageEnvironmentKeys.some((key) => Boolean(environment[key]?.trim()));
    },
    migrationForApp(): LegacyMigrationAdapter | undefined {
      return cloneMigration(legacy.migration);
    },
  };
}

/**
 * 将 Adapter 兼容岛桥接到现有 Portal 边界。旧边界仍由 Core 负责调用，Adapter
 * 只能提供声明和纯投影；未提供 legacy 时组合根继续使用通用空实现。
 */
export function createLegacyPortalCompatibilityBoundary(
  value: AdapterLegacyIntegration,
  options: LegacyCompatibilityHostOptions = {},
): PortalCompatibilityBoundary {
  const host = createLegacyCompatibilityHost(value, options);
  return Object.freeze({
    mode: "legacy" as const,
    projectEmailCodeResponse: host.projectEmailCodeResponse,
    resolveAuthRoute: host.resolveAuthRoute,
    isAuthNamespacePath: host.isAuthNamespacePath,
    projectAdminConfig: host.projectAdminConfig,
    projectRuntimeStatus: host.projectRuntimeStatus,
    isRuntimeImageConfigured: host.isRuntimeImageConfigured,
    ...(options.uploadArtifactCleanup
      ? { uploadArtifactCleanup: freezeCleanupProfile(options.uploadArtifactCleanup) }
      : {}),
  });
}

/** 兼容调用方使用的别名；新代码优先使用 createLegacyPortalCompatibilityBoundary。 */
export const createAdapterLegacyCompatibilityBoundary = createLegacyPortalCompatibilityBoundary;

function collectAuthRoutes(legacy: AdapterLegacyIntegration): ReadonlySet<string> {
  const routes = [
    ...(legacy.routes?.auth ?? []),
    ...(legacy.auth?.routeAliases?.auth ?? []),
    ...(legacy.routes?.all ?? []).filter((route) => routeOperation(route) !== undefined),
  ];
  return new Set(routes.map((route) => normalizePathname(route)).filter((route): route is string => Boolean(route)));
}

function collectAuthNamespaces(legacy: AdapterLegacyIntegration): ReadonlySet<string> {
  const namespaces = new Set<string>();
  const routes = [
    ...(legacy.routes?.auth ?? []),
    ...(legacy.auth?.routeAliases?.auth ?? []),
    ...(legacy.routes?.all ?? []),
  ];
  for (const route of routes) {
    const normalized = normalizePathname(route);
    if (!normalized) continue;
    const segments = normalized.split("/").filter(Boolean);
    if (segments.length < 2) continue;
    const operationSegment = segments.at(-1)?.toLowerCase();
    if (operationSegment === "login" || operationSegment === "sign-in"
      || operationSegment === "email-code" || operationSegment === "email-codes") {
      namespaces.add(`/${segments.slice(0, -1).join("/")}`);
    }
  }
  return namespaces;
}

function routeOperation(pathname: string): PortalCompatibilityAuthRoute["operation"] | undefined {
  const segment = pathname.replace(/\/+$/u, "").split("/").pop()?.toLowerCase();
  if (segment === "email-codes" || segment === "email-code") return "email-code";
  if (segment === "login" || segment === "sign-in") return "login";
  return undefined;
}

function normalizePathname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#")) return undefined;
  return normalized.length > 1 ? normalized.replace(/\/+$/u, "") : "/";
}

function normalizeProviderId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,127}$/u.test(normalized) ? normalized : undefined;
}

function collectImageEnvironmentKeys(
  legacy: AdapterLegacyIntegration,
  declared: readonly string[] | undefined,
): readonly string[] {
  const keys = new Set<string>(["OPENAPP_RUNTIME_IMAGE", "OPENAPP_CONTAINER_IMAGE"]);
  for (const key of declared ?? []) if (/^[A-Z_][A-Z0-9_]{0,127}$/u.test(key)) keys.add(key);
  const prefix = legacy.runtime?.profile.environmentPrefix?.trim();
  if (prefix && /^[A-Z][A-Z0-9_]{0,31}$/u.test(prefix)) {
    keys.add(`${prefix}_CONTAINER_IMAGE`);
    keys.add(`${prefix}_RUNTIME_IMAGE`);
  }
  return [...keys];
}

function cloneMigration(value: LegacyMigrationAdapter | undefined): LegacyMigrationAdapter | undefined {
  if (!value) return undefined;
  const plan = Object.freeze({
    ...value.plan,
    ...(value.plan.preserves ? { preserves: Object.freeze([...value.plan.preserves]) } : {}),
  });
  return Object.freeze({
    plan,
    ...(value.transform
      ? {
        transform: (input: unknown) => freezeData(value.transform!(cloneData(input))),
      }
      : {}),
  });
}

function freezeCleanupProfile(value: PortalUploadArtifactCleanupProfile): PortalUploadArtifactCleanupProfile {
  return Object.freeze({
    ...(value.imageTemporaryPrefixes
      ? { imageTemporaryPrefixes: Object.freeze([...value.imageTemporaryPrefixes]) }
      : {}),
    ...(value.releaseArtifactMatchers
      ? { releaseArtifactMatchers: Object.freeze([...value.releaseArtifactMatchers]) }
      : {}),
  });
}

function freezeRecord(value: unknown): Readonly<Record<string, unknown>> {
  const frozen = freezeData(value);
  return isRecord(frozen) ? frozen : Object.freeze({});
}

function cloneData(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(cloneData(entry, seen));
    return copy;
  }
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) copy[key] = cloneData(entry, seen);
  return copy;
}

function freezeData<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) freezeData(entry, seen);
  } else if (isRecord(value)) {
    for (const entry of Object.values(value)) freezeData(entry, seen);
  }
  return Object.freeze(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
