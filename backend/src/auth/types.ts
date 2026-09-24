export type AuthProviderId = string;

/** Provider-owned fields rendered by the generic authentication shell. */
export type AuthProviderFieldKind =
  | "email"
  | "verification_code"
  | "text"
  | (string & {});

export interface AuthProviderField {
  readonly id: string;
  readonly kind: AuthProviderFieldKind;
  readonly label: string;
  readonly placeholder?: string;
  readonly required?: boolean;
  readonly secret?: boolean;
  readonly maxLength?: number;
}

/** Provider 专属挑战字段；Core 只负责透传，不解释其业务语义。 */
export type AuthProviderData = Readonly<Record<string, unknown>>;

export interface AuthProviderPresentation {
  label: string;
  iconUrl: string;
  challenge: string;
  /** Optional schema; omitted by legacy providers to preserve old responses. */
  fields?: readonly AuthProviderField[];
  capabilities?: Readonly<Record<string, boolean>>;
}

export interface AuthIdentity {
  provider: AuthProviderId;
  subject: string;
  email: string;
  displayName?: string;
  isNewUser?: boolean;
}

/**
 * Core 只把下游凭证当作不透明能力；具体字段由声明该 grant 的 Provider
 * 和 App handoff 解释，不能进入普通响应、日志或持久化模型。
 */
export interface AuthCredentialGrant {
  readonly kind: string;
  readonly provider: AuthProviderId;
  readonly expiresAt?: string;
  readonly [key: string]: unknown;
}

export interface AuthLoginResult {
  identity: AuthIdentity;
  credentialGrant?: AuthCredentialGrant;
}

export interface AuthLoginInput {
  email: string;
  code: string;
  /** 新的通用入口通过此字段传递 Provider 专属字段。 */
  providerData?: AuthProviderData;
}

export interface AuthEmailCodeResult {
  /** Provider 可返回自有挑战状态；Core 只透传，不解释字段含义。 */
  providerData?: AuthProviderData;
  isNewUser?: boolean;
}

export interface AuthProvider {
  readonly id: AuthProviderId;
  readonly presentation?: AuthProviderPresentation;
  sendEmailCode(email: string): Promise<AuthEmailCodeResult | void>;
  login(input: AuthLoginInput): Promise<AuthLoginResult>;
  /** Provider 专属的 issuer、audience 和有效期校验；失败时必须拒绝继续。 */
  validateCredentialGrant?(grant: AuthCredentialGrant): void;
  /** Provider 专属的 grant 回收；未实现时由旧版兼容逻辑处理。 */
  revokeCredentialGrant?(grant: AuthCredentialGrant): Promise<void>;
  revokeSession?(refreshToken: string): Promise<void>;
}

export interface AuthService {
  readonly provider: AuthProviderId;
  readonly presentation?: AuthProviderPresentation;
  sendEmailCode(email: string): Promise<AuthEmailCodeResult | void>;
  login(input: AuthLoginInput): Promise<AuthLoginResult>;
  validateCredentialGrant?(grant: AuthCredentialGrant): void;
  revokeCredentialGrant?(grant: AuthCredentialGrant): Promise<void>;
  revokeSession?(refreshToken: string): Promise<void>;
}
