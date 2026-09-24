import type { AuthLoginInput } from "./types.js";

export type ProviderAuthOperation = "email-code" | "login";

/** 已由外部 Adapter 桥接层校验的公开错误；不携带上游异常内容。 */
export class ProviderAuthResponseError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export interface ProviderAuthErrorMapping {
  readonly status: number;
  readonly code: string;
}

/**
 * 认证兼容边界只负责把旧请求合同翻译成通用 Provider 输入，并把 Provider
 * 错误投影为稳定的 Portal 错误。Core 的会话、身份和授权逻辑不应实现这些
 * 外部协议细节。
 */
export interface ProviderAuthCompatibility {
  translateLoginInput(
    providerId: string,
    input: Record<string, unknown>,
    providerData?: Record<string, unknown>,
  ): AuthLoginInput;
  mapError(error: unknown, operation: ProviderAuthOperation): ProviderAuthErrorMapping | undefined;
  isProviderFailure(error: unknown): boolean;
}

/**
 * 新 Provider 的默认翻译器。除了已经经过 Core 基础校验的 email/code 外，
 * 所有专属字段都保持在 providerData 中，避免 Core 猜测业务字段。
 */
export const genericProviderAuthCompatibility: ProviderAuthCompatibility = {
  translateLoginInput(_providerId, input, providerData) {
    return {
      email: String(input.email),
      code: String(input.code),
      ...(providerData ? { providerData } : {}),
    };
  },

  mapError(error, operation) {
    return mapGenericProviderError(error, operation);
  },

  isProviderFailure(error) {
    return isGenericProviderFailure(error);
  },
};

export function mapGenericProviderError(
  error: unknown,
  operation: ProviderAuthOperation,
): ProviderAuthErrorMapping | undefined {
  if (error instanceof ProviderAuthResponseError) return { status: error.status, code: error.code };
  const message = error instanceof Error && error.message ? error.message : "auth_failed";
  const stableStatus: Record<string, number> = {
    verification_code_invalid: 401,
    rate_limited: 429,
    user_disabled: 403,
    auth_provider_not_found: 404,
    auth_provider_credential_grant_mismatch: 502,
    auth_provider_credential_grant_invalid: 502,
    auth_provider_session_revoke_unavailable: 502,
    external_adapter_auth_identity_mismatch: 502,
    external_adapter_auth_identity_invalid: 502,
    external_adapter_auth_error_mapping_invalid: 502,
  };
  const stable = stableStatus[message];
  if (stable !== undefined) return { status: stable, code: message };
  if (message.includes(":network")) return { status: 502, code: message };

  const upstreamStatus = Number(message.match(/:(\d{3})(?::|$)/u)?.[1] ?? 0);
  if (upstreamStatus === 429) return { status: 429, code: message };
  if (upstreamStatus >= 500) return { status: 502, code: message };
  return { status: operation === "login" ? 401 : 400, code: message };
}

export function isGenericProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.startsWith("auth_provider_")
    || error.message.startsWith("external_adapter_")
    || ["verification_code_invalid", "rate_limited", "user_disabled"].includes(error.message);
}
