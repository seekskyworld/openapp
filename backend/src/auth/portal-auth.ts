import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AuthenticatedUser, AuthMethod, User } from "../models.js";
import { isManagementRole } from "../user-role-policy.js";
import type { AuthCredentialGrant, AuthEmailCodeResult, AuthProviderId, AuthService } from "./types.js";
import { LocalAuthRateLimiter, type LocalAuthOperation } from "./local-auth-rate-limit.js";
import { hashLocalPassword, validateLocalPassword, verifyLocalPassword } from "./local-password.js";
import { AuthProviderRegistry, type ExternalAuthProviderDescription } from "./provider-registry.js";
import { AccountCredentialError, AccountCredentials } from "./account-credentials.js";
import {
  genericProviderAuthCompatibility,
  mapGenericProviderError,
  type ProviderAuthCompatibility,
} from "./provider-compatibility.js";

export const CLI_ADMIN_ID = "openapp-cli-admin";

export class PortalAuthError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

/** Persistence seam for identity records and hashed Portal sessions. */
export interface AuthRepository {
  findUserByEmail(email: string): Promise<User | null>;
  findUserByIdentity(provider: AuthProviderId | "local", subject: string): Promise<User | null>;
  findOrCreateUser(email: string, subject?: string, provider?: AuthProviderId | "local"): Promise<User>;
  createLocalUser(email: string, passwordHash: string): Promise<User | null>;
  getLocalPasswordHash(userId: string): Promise<string | null>;
  getAccountAuthState(userId: string): Promise<import("../models.js").AccountAuthState>;
  createLocalPasswordHash(userId: string, passwordHash: string): Promise<boolean>;
  replaceLocalPasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<boolean>;
  saveSession(hash: string, userId: string, expiresAt: Date, authMethod: AuthMethod): Promise<void>;
  deleteSession(hash: string): Promise<void>;
  sessionUser(hash: string): Promise<AuthenticatedUser | null>;
}

export interface PortalAuthConfig {
  cookieName: string;
  secureCookies: boolean;
  sessionTtlHours: number;
  adminCliToken: string;
}

export interface PortalLoginResult {
  user: AuthenticatedUser;
  isNewUser: boolean;
  provider: "local" | AuthProviderId;
  setCookie: string;
  credentialGrant?: AuthCredentialGrant;
}

/**
 * Owns all Portal-facing authentication policy. HTTP handlers only translate
 * request bodies and responses; provider errors and session details stay here.
 */
export class PortalAuth {
  readonly #externalAuth: AuthProviderRegistry;
  readonly #credentials: AccountCredentials;

  constructor(
    readonly provider: AuthProviderId,
    auth: AuthService,
    private readonly repository: AuthRepository,
    private readonly config: PortalAuthConfig,
    private readonly localAuthRateLimiter = new LocalAuthRateLimiter(),
    externalAuth?: AuthProviderRegistry,
    private readonly providerCompatibility: ProviderAuthCompatibility = genericProviderAuthCompatibility,
  ) {
    // 组合根可注入多 Provider 注册表；直接构造时只注册显式传入的认证服务。
    this.#externalAuth = externalAuth ?? new AuthProviderRegistry([auth]);
    this.#credentials = new AccountCredentials(repository, this.#externalAuth);
  }

  externalProviders(): ExternalAuthProviderDescription[] {
    return this.#externalAuth.list();
  }

  async sendEmailCode(input: unknown): Promise<AuthEmailCodeResult> {
    return this.sendExternalEmailCode(this.provider, input);
  }

  async sendExternalEmailCode(providerId: string, input: unknown): Promise<AuthEmailCodeResult> {
    const email = normalizeEmail(input);
    if (!email) throw new PortalAuthError(400, "valid_email_required");
    try {
      return await this.#externalAuth.sendEmailCode(providerId, email);
    } catch (error) {
      throw mapAuthError(error, "email-code", this.providerCompatibility);
    }
  }

  /** 供 App handoff 回滚刚签发的任意 Provider grant；凭证始终由注册表拥有。 */
  async revokeCredentialGrant(providerId: string, grant: AuthCredentialGrant): Promise<void> {
    await this.#externalAuth.revokeCredentialGrant(providerId, grant);
  }

  async login(input: Record<string, unknown>): Promise<PortalLoginResult> {
    return this.loginExternal(this.provider, input);
  }

  async loginExternal(providerId: string, input: Record<string, unknown>): Promise<PortalLoginResult> {
    const email = normalizeEmail(input.email);
    if (!email) throw new PortalAuthError(400, "valid_email_required");
    const code = typeof input.code === "string" ? input.code.trim() : "";
    if (!code || code.length > 256) throw new PortalAuthError(400, "verification_code_required");

    const providerFields = this.#externalAuth.list()
      .find((provider) => provider.id === providerId.trim().toLowerCase())?.fields;
    // 旧入口曾把 Provider 字段放在请求顶层。将其投影到 Provider 自己声明的
    // schema 中，保持兼容而不让 Core 解释自定义字段的业务语义。
    const providerData = normalizeProviderData(input.providerData, providerFields, input);
    let providerInput;
    try {
      providerInput = this.providerCompatibility.translateLoginInput(
        providerId,
        { ...input, email, code },
        providerData,
      );
    } catch (error) {
      throw mapAuthError(error, "login", this.providerCompatibility);
    }
    let loginResult: Awaited<ReturnType<AuthProviderRegistry["login"]>>;
    try {
      loginResult = await this.#externalAuth.login(providerId, providerInput);
    } catch (error) {
      throw mapAuthError(error, "login", this.providerCompatibility);
    }
    const { identity } = loginResult;
    const grant = loginResult.credentialGrant;
    try {
      // External identity is authoritative by provider+subject. A verified email
      // may link to an existing account, but a new external account is always
      // created with the repository's ordinary-user default role.
      let user = await this.repository.findUserByIdentity(identity.provider, identity.subject);
      if (!user) {
        user = await this.repository.findOrCreateUser(identity.email, identity.subject, identity.provider);
      }
      return await this.issueSession(user, identity.provider, identity.isNewUser === true, grant);
    } catch (error) {
      try {
        await this.#externalAuth.revokeCredentialGrant(providerId, grant);
      } catch {
        console.warn("[OpenApp auth] credential grant revocation failed after Portal login failure");
      }
      throw error;
    }
  }

  async registerLocal(input: Record<string, unknown>, source = "unknown"): Promise<PortalLoginResult> {
    const email = normalizeEmail(input.email);
    if (!email) throw new PortalAuthError(400, "valid_email_required");
    this.consumeLocalAuthAttempt("register", source, email);
    const password = readLocalPassword(input.password);
    if (await this.repository.findUserByEmail(email)) throw new PortalAuthError(409, "account_exists");
    const user = await this.repository.createLocalUser(email, await hashLocalPassword(password));
    if (!user) throw new PortalAuthError(409, "account_exists");
    return this.issueSession(user, "local", true);
  }

  async loginLocal(input: Record<string, unknown>, source = "unknown"): Promise<PortalLoginResult> {
    const user = await this.authenticateLocal(input, source);
    return this.issueSession(user, "local", false);
  }

  async loginLocalAdmin(input: Record<string, unknown>, source = "unknown"): Promise<PortalLoginResult> {
    const user = await this.authenticateLocal(input, source);
    if (!isManagementRole(user.role)) throw new PortalAuthError(403, "admin_required");
    return this.issueSession(user, "local", false);
  }

  private async authenticateLocal(input: Record<string, unknown>, source: string): Promise<User> {
    const email = normalizeEmail(input.email);
    if (!email) throw new PortalAuthError(400, "valid_email_required");
    this.consumeLocalAuthAttempt("login", source, email);
    const password = typeof input.password === "string" ? input.password : "";
    const user = await this.repository.findUserByEmail(email);
    const passwordHash = user ? await this.repository.getLocalPasswordHash(user.id) : null;
    if (!user || !passwordHash || !(await verifyLocalPassword(password, passwordHash))) {
      throw new PortalAuthError(401, "invalid_credentials");
    }
    return user;
  }

  private consumeLocalAuthAttempt(operation: LocalAuthOperation, source: string, email: string): void {
    if (!this.localAuthRateLimiter.consume(operation, source, email)) {
      throw new PortalAuthError(429, "rate_limited");
    }
  }

  async prepareLocalCredential(emailInput: unknown, passwordInput: unknown): Promise<{ email: string; passwordHash: string }> {
    const email = normalizeEmail(emailInput);
    if (!email) throw new PortalAuthError(400, "valid_email_required");
    const password = readLocalPassword(passwordInput);
    return { email, passwordHash: await hashLocalPassword(password) };
  }

  private async issueSession(
    user: User,
    authMethod: "local" | AuthProviderId,
    isNewUser: boolean,
    credentialGrant?: AuthCredentialGrant,
  ): Promise<PortalLoginResult> {
    const projectedUser = await this.#credentials.project(user, authMethod);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + this.config.sessionTtlHours * 3_600_000);
    await this.repository.saveSession(hashToken(token), user.id, expiresAt, authMethod);
    return {
      user: projectedUser,
      isNewUser,
      provider: authMethod,
      setCookie: this.serializeCookie(token, this.config.sessionTtlHours * 3_600),
      ...(credentialGrant ? { credentialGrant } : {}),
    };
  }

  async session(request: IncomingMessage): Promise<AuthenticatedUser | null> {
    const user = await this.readUser(request);
    return isUnlinkedExternalSession(user) ? null : user;
  }

  async logout(request: IncomingMessage): Promise<string> {
    const token = this.readSessionToken(request);
    if (token) await this.repository.deleteSession(hashToken(token));
    return this.clearSessionCookie();
  }

  /**
   * Rolls back a session issued for a response that could not complete its
   * downstream App handoff. The raw token is accepted only in memory from the
   * freshly serialized Set-Cookie value and is never persisted or returned.
   */
  async revokeIssuedSession(setCookie: string): Promise<void> {
    const token = readSerializedCookie(setCookie, this.config.cookieName);
    if (token) await this.repository.deleteSession(hashToken(token));
  }

  clearSessionCookie(): string {
    return this.serializeCookie("", 0);
  }

  async requireUser(request: IncomingMessage): Promise<AuthenticatedUser> {
    const user = await this.requireAuthenticated(request);
    if (isManagementRole(user.role) && user.passwordSetupRequired) {
      throw new PortalAuthError(403, "password_setup_required");
    }
    return user;
  }

  async requireAuthenticated(request: IncomingMessage): Promise<AuthenticatedUser> {
    const user = await this.readUser(request);
    if (!user) throw new PortalAuthError(401, "authentication_required");
    if (isUnlinkedExternalSession(user)) throw new PortalAuthError(401, "authentication_required");
    return user;
  }

  async setupPassword(user: AuthenticatedUser, input: Record<string, unknown>, source = "unknown"): Promise<PortalLoginResult> {
    this.consumeLocalAuthAttempt("password-setup", source, user.email);
    const updated = await this.runCredentialOperation(() => this.#credentials.setup(user, input.newPassword));
    return this.issueSession(updated, readSessionAuthMethod(user), false);
  }

  async changePassword(user: AuthenticatedUser, input: Record<string, unknown>, source = "unknown"): Promise<PortalLoginResult> {
    this.consumeLocalAuthAttempt("password-change", source, user.email);
    const updated = await this.runCredentialOperation(() => this.#credentials.changeWithCurrentPassword(
      user,
      input.currentPassword,
      input.newPassword,
    ));
    return this.issueSession(updated, "local", false);
  }

  async sendExternalPasswordCode(user: AuthenticatedUser, providerId: string, source = "unknown"): Promise<void> {
    this.consumeLocalAuthAttempt("external-password-code", source, user.email);
    await this.runCredentialOperation(() => this.#credentials.sendExternalCode(user, providerId));
  }

  async changePasswordWithExternal(
    user: AuthenticatedUser,
    providerId: string,
    input: Record<string, unknown>,
    source = "unknown",
  ): Promise<PortalLoginResult> {
    this.consumeLocalAuthAttempt("external-password-change", source, user.email);
    const updated = await this.runCredentialOperation(() => this.#credentials.changeWithExternal(
      user,
      providerId,
      input.code,
      input.newPassword,
    ));
    return this.issueSession(updated, providerId as AuthProviderId, false);
  }

  private async runCredentialOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AccountCredentialError) throw mapCredentialError(error);
      if (this.providerCompatibility.isProviderFailure(error)) {
        throw mapAuthError(error, "login", this.providerCompatibility);
      }
      throw error;
    }
  }

  async requireAdmin(request: IncomingMessage): Promise<AuthenticatedUser> {
    const user = await this.requireUser(request);
    if (!isManagementRole(user.role)) throw new PortalAuthError(403, "admin_required");
    return user;
  }

  requireSuperAdmin(user: AuthenticatedUser): void {
    if (user.role !== "super_admin") throw new PortalAuthError(403, "super_admin_required");
    this.requireInteractiveAdmin(user);
  }

  requireInteractiveAdmin(user: AuthenticatedUser): void {
    if (user.id === CLI_ADMIN_ID) {
      throw new PortalAuthError(403, "interactive_admin_required");
    }
  }

  private async readUser(request: IncomingMessage): Promise<AuthenticatedUser | null> {
    const adminToken = readHeader(request.headers["x-openapp-admin-token"]);
    if (adminToken && tokenEquals(this.config.adminCliToken, adminToken)) {
      return {
        id: CLI_ADMIN_ID,
        email: "cli-admin@local",
        role: "admin",
        createdAt: new Date(0).toISOString(),
        appInitializedAt: null,
        authMethod: "cli",
        passwordSetupRequired: false,
        linkedProviders: [],
      };
    }
    const token = this.readSessionToken(request);
    return token ? this.repository.sessionUser(hashToken(token)) : null;
  }

  private readSessionToken(request: IncomingMessage): string | undefined {
    for (const part of request.headers.cookie?.split(";") ?? []) {
      const separator = part.indexOf("=");
      if (separator <= 0 || part.slice(0, separator).trim() !== this.config.cookieName) continue;
      try {
        return decodeURIComponent(part.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
    return request.headers.authorization?.match(/^Bearer\s+(.+)$/iu)?.[1]?.trim();
  }

  private serializeCookie(value: string, maxAge: number): string {
    return [
      `${this.config.cookieName}=${encodeURIComponent(value)}`,
      "Path=/",
      `Max-Age=${Math.max(0, Math.floor(maxAge))}`,
      "HttpOnly",
      "SameSite=Lax",
      this.config.secureCookies ? "Secure" : undefined,
    ].filter(Boolean).join("; ");
  }
}

function mapAuthError(
  error: unknown,
  operation: "email-code" | "login",
  compatibility: ProviderAuthCompatibility,
): PortalAuthError {
  const mapped = compatibility.mapError(error, operation) ?? mapGenericProviderError(error, operation);
  return new PortalAuthError(mapped?.status ?? (operation === "login" ? 401 : 400), mapped?.code ?? "auth_failed");
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : "";
}

function normalizeProviderData(
  value: unknown,
  declaredFields: readonly { id: string }[] | undefined = undefined,
  legacyInput: Record<string, unknown> | undefined = undefined,
): Record<string, unknown> | undefined {
  const source: Record<string, unknown> = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
  // Only declared fields may be recovered from the historical top-level shape.
  // Explicit providerData remains authoritative when both forms are present.
  for (const field of declaredFields ?? []) {
    if (Object.hasOwn(source, field.id) || !legacyInput || !Object.hasOwn(legacyInput, field.id)) continue;
    source[field.id] = legacyInput[field.id];
  }
  const entries = Object.entries(source)
    .filter(([key]) => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key))
    .slice(0, 32)
    .map(([key, entry]) => [key, sanitizeProviderValue(entry)] as const)
    .filter(([, entry]) => entry !== undefined);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function sanitizeProviderValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function readLocalPassword(value: unknown): string {
  try {
    return validateLocalPassword(value);
  } catch (error) {
    const code = error instanceof Error ? error.message : "password_required";
    throw new PortalAuthError(400, code);
  }
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isUnlinkedExternalSession(user: AuthenticatedUser | null): boolean {
  return Boolean(
    user
    && user.authMethod !== "local"
    && user.authMethod !== "cli"
    && !user.linkedProviders.includes(user.authMethod),
  );
}

function readSessionAuthMethod(user: AuthenticatedUser): "local" | AuthProviderId {
  if (user.authMethod !== "cli") return user.authMethod;
  throw new PortalAuthError(403, "password_setup_not_allowed");
}

function mapCredentialError(error: AccountCredentialError): PortalAuthError {
  const statuses: Record<string, number> = {
    password_required: 400,
    password_too_short: 400,
    password_too_long: 400,
    verification_code_required: 400,
    invalid_current_password: 401,
    password_setup_not_allowed: 403,
    external_password_change_not_allowed: 403,
    external_identity_not_linked: 403,
    external_identity_mismatch: 403,
    password_already_set: 409,
    local_credentials_required: 409,
    credential_update_conflict: 409,
  };
  return new PortalAuthError(statuses[error.code] ?? 400, error.code);
}

function readHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0]?.trim() : value?.trim();
}

function readSerializedCookie(value: string, name: string): string | undefined {
  const pair = value.split(";", 1)[0] ?? "";
  const separator = pair.indexOf("=");
  if (separator <= 0 || pair.slice(0, separator).trim() !== name) return undefined;
  try {
    return decodeURIComponent(pair.slice(separator + 1).trim()) || undefined;
  } catch {
    return undefined;
  }
}

function tokenEquals(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}
