import type {
  AuthCredentialGrant,
  AuthEmailCodeResult,
  AuthIdentity,
  AuthLoginInput,
  AuthLoginResult,
  AuthProviderField,
  AuthProviderId,
  AuthService,
} from "./types.js";

export interface ExternalAuthProviderDescription {
  id: AuthProviderId;
  label: string;
  iconUrl: string;
  challenge: string;
  /** Provider-owned fields rendered by the generic entry shell. */
  fields?: readonly AuthProviderField[];
  capabilities?: Readonly<Record<string, boolean>>;
}

export interface AuthProviderRegistryOptions {
  /** 纯通用/无认证 App 可以显式使用空的外部 Provider 集合。 */
  readonly allowEmpty?: boolean;
}

export class AuthProviderRegistry {
  readonly #providers = new Map<AuthProviderId, AuthService>();

  constructor(providers: readonly AuthService[], options: AuthProviderRegistryOptions = {}) {
    for (const provider of providers) {
      if (this.#providers.has(provider.provider)) throw new Error("duplicate_auth_provider");
      this.#providers.set(provider.provider, provider);
    }
    if (!this.#providers.size && options.allowEmpty !== true) throw new Error("auth_provider_required");
  }

  has(providerId: string): boolean {
    return this.#providers.has(providerId.trim().toLowerCase());
  }

  /** 返回已构造的服务实例；调用方不得替换注册表中的 Provider。 */
  service(providerId: string): AuthService | undefined {
    return this.#providers.get(providerId.trim().toLowerCase() as AuthProviderId);
  }

  providerIds(): readonly AuthProviderId[] {
    return [...this.#providers.keys()];
  }

  list(providerIds?: readonly string[]): ExternalAuthProviderDescription[] {
    const selected = providerIds === undefined
      ? [...this.#providers.values()]
      : providerIds
        .map((providerId) => this.#providers.get(providerId.trim().toLowerCase() as AuthProviderId))
        .filter((provider): provider is AuthService => Boolean(provider));
    return selected.map((provider) => {
      // 品牌、字段和挑战协议必须由 Provider 自己声明；注册表只提供中性兜底，
      // 不读取产品名称或旧协议字段。
      const presentation = provider.presentation ?? defaultPresentation(provider.provider);
      return {
        id: provider.provider,
        ...presentation,
        ...(presentation.fields ? { fields: presentation.fields.map((field) => ({ ...field })) } : {}),
        ...(presentation.capabilities ? { capabilities: { ...presentation.capabilities } } : {}),
      };
    });
  }

  async sendEmailCode(providerId: string, email: string): Promise<AuthEmailCodeResult> {
    return await this.get(providerId).sendEmailCode(email) ?? {};
  }

  async login(providerId: string, input: AuthLoginInput): Promise<AuthLoginResult> {
    const provider = this.get(providerId);
    const result = await provider.login(input);
    try {
      if (result.identity.provider !== provider.provider) throw new Error("auth_provider_identity_mismatch");
      validateCredentialGrant(provider, result.credentialGrant);
      return result;
    } catch (error) {
      try {
        await this.revokeCredentialGrant(providerId, result.credentialGrant);
      } catch {
        console.warn("[OpenApp auth] credential grant revocation failed after provider validation");
      }
      throw error;
    }
  }

  async verifyIdentityWithEphemeralLogin(providerId: string, input: AuthLoginInput): Promise<AuthIdentity> {
    const result = await this.login(providerId, input);
    try {
      return result.identity;
    } finally {
      await this.revokeCredentialGrant(providerId, result.credentialGrant);
    }
  }

  async revokeCredentialGrant(providerId: string, grant: AuthCredentialGrant | undefined): Promise<void> {
    const provider = this.get(providerId);
    if (!grant) return;
    if (grant.provider !== provider.provider) {
      throw new Error("auth_provider_credential_grant_mismatch");
    }
    // grant 的字段和撤销协议始终由拥有它的 Provider 解释；Core 不再按
    // refreshToken 等历史字段猜测如何回收凭证。
    if (provider.revokeCredentialGrant) {
      await provider.revokeCredentialGrant(grant);
      return;
    }
    throw new Error("auth_provider_session_revoke_unavailable");
  }

  private get(providerId: string): AuthService {
    const provider = this.#providers.get(providerId.trim().toLowerCase() as AuthProviderId);
    if (!provider) throw new Error("auth_provider_not_found");
    return provider;
  }
}

function validateCredentialGrant(provider: AuthService, grant: AuthCredentialGrant | undefined): void {
  if (!grant) return;
  if (!isSafeGrantKind(grant.kind) || grant.provider !== provider.provider) {
    throw new Error("auth_provider_credential_grant_mismatch");
  }
  provider.validateCredentialGrant?.(grant);
}

function isSafeGrantKind(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value);
}

function defaultPresentation(providerId: string): Omit<ExternalAuthProviderDescription, "id"> {
  return { label: providerId, iconUrl: "/openapp-logo.png", challenge: "email_code" };
}
