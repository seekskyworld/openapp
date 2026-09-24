import type {
  AccessTarget,
  AccessTargetRequest,
  AccessTargetResolver,
} from "./execution-provider.js";
import { ProviderOperationError } from "./execution-provider.js";

const FORBIDDEN_PROVIDER_HEADERS = new Set([
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-openapp-admin-token",
]);
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/**
 * AccessTarget 只能在访问平面内短暂存在。这里复制并校验 Provider 结果，避免可变 URL、
 * 过期凭证或 Header 注入进入 transport。
 */
export async function resolveWorkspaceAccessTarget(
  resolver: AccessTargetResolver,
  request: AccessTargetRequest,
  now: () => number = Date.now,
): Promise<AccessTarget> {
  try {
    request.signal?.throwIfAborted();
    const resolved = await resolver.resolveAccessTarget(request);
    request.signal?.throwIfAborted();
    const url = trustedUrl(resolved.url);
    assertTrustedEnvironmentRef(resolved.environmentRef);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(resolved.providerId) || resolved.logicalService !== request.logicalService) {
      throw inconsistentTarget();
    }
    if (resolved.expiresAt !== null) {
      const expiresAt = Date.parse(resolved.expiresAt);
      if (!Number.isFinite(expiresAt)) throw inconsistentTarget();
      if (expiresAt <= now()) {
        throw new ProviderOperationError(
          "provider_access_target_expired",
          "transient",
          "resolve_target",
          0,
        );
      }
    }
    return {
      providerId: resolved.providerId,
      environmentRef: resolved.environmentRef,
      logicalService: resolved.logicalService,
      url,
      expiresAt: resolved.expiresAt,
      ...(resolved.authority === undefined ? {} : { authority: trustedAuthority(resolved.authority) }),
      ...(resolved.headers === undefined ? {} : { headers: trustedHeaders(resolved.headers) }),
    };
  } catch (error) {
    if (error instanceof ProviderOperationError) throw error;
    if (request.signal?.aborted || isAbortError(error)) {
      throw new ProviderOperationError(
        "provider_operation_cancelled",
        "cancelled",
        "resolve_target",
        undefined,
        { cause: error },
      );
    }
    // Resolver 的原始异常可能包含内部地址或临时凭证，公开边界只保留稳定错误码。
    throw new ProviderOperationError(
      "provider_access_target_resolution_failed",
      "transient",
      "resolve_target",
      1_000,
      { cause: error },
    );
  }
}

export function assertAccessTargetEnvironment(target: AccessTarget, expectedEnvironmentRef: string): void {
  if (target.environmentRef !== expectedEnvironmentRef) throw inconsistentTarget();
}

function trustedUrl(value: URL): URL {
  let url: URL;
  try {
    url = new URL(value.href);
  } catch {
    throw inconsistentTarget();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || !url.hostname
    || url.username
    || url.password
    || url.hash
    || url.href.length > 8_192
  ) {
    throw inconsistentTarget();
  }
  return url;
}

function trustedAuthority(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 512 || /[\r\n/@]/u.test(normalized)) throw inconsistentTarget();
  try {
    const parsed = new URL(`http://${normalized}`);
    if (parsed.host !== normalized || parsed.pathname !== "/") throw inconsistentTarget();
  } catch {
    throw inconsistentTarget();
  }
  return normalized;
}

function trustedHeaders(headers: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (Object.keys(headers).length > 64) throw inconsistentTarget();
  const trusted: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.trim().toLowerCase();
    if (
      !HEADER_NAME.test(name)
      || FORBIDDEN_PROVIDER_HEADERS.has(name)
      || Object.hasOwn(trusted, name)
      || typeof value !== "string"
      || value.length > 8_192
      || /[\r\n]/u.test(value)
    ) {
      throw inconsistentTarget();
    }
    trusted[name] = value;
  }
  return Object.freeze(trusted);
}

function assertTrustedEnvironmentRef(value: string): void {
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > 512) throw inconsistentTarget();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function inconsistentTarget(): ProviderOperationError {
  return new ProviderOperationError(
    "provider_access_target_invalid",
    "inconsistent",
    "resolve_target",
  );
}
