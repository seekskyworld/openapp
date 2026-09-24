import type { ProxyOptions } from "../proxy.js";
import type { AuthCredentialGrant } from "./types.js";
import { APP_ID_PATTERN } from "../app-id.js";

export type AppAuthRevocationReason = "login_replaced" | "logout" | "materialize_failed";

export interface AppAuthLoginInput {
  readonly cookieHeader?: string;
  readonly credentialGrant?: AuthCredentialGrant;
  readonly sessionId: string;
  readonly secureCookies: boolean;
  readonly instanceIds?: readonly string[];
  readonly revokeRefreshSession?: (
    refreshToken: string,
    reason: AppAuthRevocationReason,
  ) => Promise<void>;
  /** Provider 无关的凭证回收；旧 Provider 调用方继续使用 revokeRefreshSession。 */
  readonly revokeCredentialGrant?: (
    grant: AuthCredentialGrant,
    reason: AppAuthRevocationReason,
  ) => Promise<void>;
  /**
   * Deprecated opaque-grant fallback for adapters that still expose only a
   * refresh-session callback.  The coordinator deliberately does not inspect
   * provider or token fields; the compatibility boundary supplies this hook.
   */
  readonly revokeOpaqueCredentialGrant?: (
    grant: AuthCredentialGrant,
    reason: AppAuthRevocationReason,
  ) => Promise<void>;
}

export interface AppAuthLogoutInput {
  readonly cookieHeader?: string;
  readonly secureCookies: boolean;
  readonly instanceIds?: readonly string[];
  /** Provider-agnostic grant revocation for adapters that own opaque grants. */
  readonly revokeCredentialGrant?: (
    grant: AuthCredentialGrant,
    reason: AppAuthRevocationReason,
  ) => Promise<void>;
  readonly revokeOpaqueCredentialGrant?: (
    grant: AuthCredentialGrant,
    reason: AppAuthRevocationReason,
  ) => Promise<void>;
  readonly revokeRefreshSession?: (
    refreshToken: string,
    reason: AppAuthRevocationReason,
  ) => Promise<void>;
}

export interface AppAuthProxyInput {
  readonly instanceId: string;
  readonly secureCookies: boolean;
}

export interface AppAuthHandoffCoordinatorOptions {
  /** Resolve a user's existing instance App before login; return null to use the default. */
  readonly resolveAppId?: (userId: string) => string | null | Promise<string | null>;
  /** Used on first SSO login, before the user has an instance row. */
  readonly defaultAppId?: string;
  /**
   * Resolves credential-free Apps from the durable catalog. This is queried on
   * demand so a second Portal process observes Apps created by another process
   * without requiring a restart. Credentialed adapters never use this hook.
   */
  readonly resolveNoAuthApp?: (appId: string) => boolean | Promise<boolean>;
}

/** A statically registered adapter that materializes one App's downstream authentication. */
export interface AppAuthHandoff {
  readonly appId: string;
  readonly managedCookieNames: readonly string[];
  onLogin(input: AppAuthLoginInput): Promise<readonly string[]>;
  onLogout(input: AppAuthLogoutInput): Promise<readonly string[]>;
  proxyOptions(input: AppAuthProxyInput): Readonly<ProxyOptions>;
  /** Declares the one reviewed downstream consumer for a provider grant. */
  acceptsCredentialGrant?(grant: AuthCredentialGrant): boolean;
  /** Proves that this browser already carries the App-specific session. */
  hasSession?(cookieHeader: string | undefined): boolean;
}

export class AppAuthHandoffError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface AppAuthHandoffRegistryOptions {
  readonly portalCookieName: string;
  readonly handoffs: readonly AppAuthHandoff[];
}

/**
 * Immutable startup registry. App authentication behavior is code-owned and
 * cannot be changed by database configuration or a request payload.
 */
export class AppAuthHandoffRegistry {
  readonly #handoffs: ReadonlyMap<string, AppAuthHandoff>;
  readonly #managedCookieNames: readonly string[];
  readonly portalCookieName: string;

  constructor(options: AppAuthHandoffRegistryOptions) {
    this.portalCookieName = validateCookieName(options.portalCookieName);
    const handoffs = new Map<string, AppAuthHandoff>();
    const cookieOwners = new Map<string, string>();

    for (const handoff of options.handoffs) {
      const appId = normalizeAppId(handoff.appId);
      if (handoffs.has(appId)) {
        throw new AppAuthHandoffError("app_auth_handoff_duplicate_app_id");
      }
      const appCookieNames = new Set<string>();
      for (const rawCookieName of handoff.managedCookieNames) {
        const cookieName = validateCookieName(rawCookieName);
        const key = cookieName.toLowerCase();
        if (key === this.portalCookieName.toLowerCase()) {
          throw new AppAuthHandoffError("app_auth_handoff_portal_cookie_conflict");
        }
        if (appCookieNames.has(key) || cookieOwners.has(key)) {
          throw new AppAuthHandoffError("app_auth_handoff_duplicate_cookie_name");
        }
        appCookieNames.add(key);
        cookieOwners.set(key, cookieName);
      }
      handoffs.set(appId, handoff);
    }

    this.#handoffs = handoffs;
    this.#managedCookieNames = [...cookieOwners.values()];
  }

  get(appId: string): AppAuthHandoff | undefined {
    const normalized = normalizeAppIdOrUndefined(appId);
    return normalized ? this.#handoffs.get(normalized) : undefined;
  }

  managedCookieNames(): readonly string[] {
    return [...this.#managedCookieNames];
  }

  list(): readonly AppAuthHandoff[] {
    return [...this.#handoffs.values()];
  }
}

/** Public entry point used by Portal login, logout, and instance proxy flows. */
export class AppAuthHandoffCoordinator {
  readonly #resolveAppId?: AppAuthHandoffCoordinatorOptions["resolveAppId"];
  readonly #defaultAppId?: string;
  readonly #resolveNoAuthApp?: AppAuthHandoffCoordinatorOptions["resolveNoAuthApp"];
  readonly #noAuthHandoffs = new Map<string, AppAuthHandoff>();

  constructor(
    private readonly registry: AppAuthHandoffRegistry,
    options: AppAuthHandoffCoordinatorOptions = {},
  ) {
    this.#resolveAppId = options.resolveAppId;
    this.#defaultAppId = options.defaultAppId;
    this.#resolveNoAuthApp = options.resolveNoAuthApp;
    if (this.#defaultAppId !== undefined
      && !this.registry.get(this.#defaultAppId)
      && !this.#resolveNoAuthApp) {
      throw new AppAuthHandoffError("app_auth_handoff_default_app_not_registered");
    }
  }

  async onLogin(appId: string, input: AppAuthLoginInput): Promise<readonly string[]> {
    try {
      return await this.materializeLogin(this.require(appId), input);
    } catch (error) {
      await revokeNewGrantBestEffort(input, "materialize_failed");
      throw error;
    }
  }

  private async materializeLogin(selected: AppAuthHandoff, input: AppAuthLoginInput): Promise<readonly string[]> {
    // Every adapter gets one cleanup pass, but only the adapter selected by
    // server-owned App state receives the new grant. This prevents a shared
    // provider token from being materialized into unrelated App cookies.
    const results: string[] = [];
    for (const handoff of this.registry.list()) {
      if (handoff === selected) continue;
      results.push(...await handoff.onLogin({ ...input, credentialGrant: undefined }));
    }
    // Materialize the new grant last. If an unrelated adapter cannot clean
    // up, no new downstream credential has been issued yet.
    results.push(...await selected.onLogin(input));
    return results;
  }

  /** Resolve exactly one adapter; never broadcasts a credential grant to all Apps. */
  async onLoginForUser(userId: string, input: AppAuthLoginInput): Promise<readonly string[]> {
    try {
      const consumer = input.credentialGrant ? this.#credentialConsumer(input.credentialGrant) : null;
      const resolvedApp = await this.resolveAppIdForUser(userId);
      const resolved = await this.requireAsync(resolvedApp);
      let selected = resolved;
      if (consumer) {
        // A credentialed existing instance must keep its own downstream
        // session. A no-auth instance may still receive the provider session
        // so the user can later enter a credentialed App without logging in
        // again; the no-auth proxy will strip those cookies.
        if (this.registry.get(resolvedApp) && resolvedApp !== consumer.appId) {
          throw new AppAuthHandoffError("app_auth_credential_app_mismatch");
        }
        if (!this.registry.get(resolvedApp)) selected = consumer;
      }
      return await this.materializeLogin(selected, input);
    } catch (error) {
      await revokeNewGrantBestEffort(input, "materialize_failed");
      throw error;
    }
  }

  async onLogout(appId: string, input: AppAuthLogoutInput): Promise<readonly string[]> {
    this.require(appId);
    return this.onLogoutAll(input);
  }

  async onLogoutAll(input: AppAuthLogoutInput): Promise<readonly string[]> {
    const results = await Promise.all(this.registry.list().map(async (handoff) => {
      try {
        return [...await handoff.onLogout(input)];
      } catch (error) {
        console.warn(`[OpenApp auth] App handoff logout failed for ${handoff.appId}`);
        // Keep logout best-effort even when an adapter is unavailable. Every
        // declared cookie gets a conservative root-scope deletion fallback.
        return handoff.managedCookieNames.map((name) => clearRootCookie(name, input.secureCookies));
      }
    }));
    return results.flat();
  }

  supportsApp(appId: string): boolean {
    return Boolean(this.registry.get(appId) ?? this.#noAuthHandoffs.get(normalizeAppIdOrUndefined(appId) ?? ""));
  }

  /** Returns whether an App has a reviewed, credentialed adapter. */
  supportsCredentialedApp(appId: string): boolean {
    return Boolean(this.registry.get(appId));
  }

  /** Credentialed Apps must prove their downstream session before creation. */
  hasAppSession(appId: string, cookieHeader: string | undefined): boolean {
    const handoff = this.registry.get(appId);
    return Boolean(handoff?.hasSession?.(cookieHeader));
  }

  /** Resolves both static adapters and durable credential-free catalog Apps. */
  async supportsAppAsync(appId: string): Promise<boolean> {
    const normalized = normalizeAppIdOrUndefined(appId);
    if (!normalized) return false;
    if (this.registry.get(normalized) || this.#noAuthHandoffs.has(normalized)) return true;
    if (!this.#resolveNoAuthApp || !await this.#resolveNoAuthApp(normalized)) return false;
    this.registerNoAuthApp(normalized);
    return true;
  }

  /** Adds a credential-free App entry; it can never forward a provider token. */
  registerNoAuthApp(appId: string): void {
    const normalized = normalizeAppId(appId);
    if (this.registry.get(normalized)) return;
    this.#noAuthHandoffs.set(normalized, new NoAuthAppHandoff(normalized));
  }

  /** Returns static adapter ids plus explicitly registered credential-free Apps. */
  listApps(): readonly string[] {
    return [...this.registry.list().map((handoff) => handoff.appId), ...this.#noAuthHandoffs.keys()];
  }

  async resolveAppIdForUser(userId: string): Promise<string> {
    const resolved = this.#resolveAppId ? await this.#resolveAppId(userId) : null;
    const appId = resolved ?? this.#defaultAppId;
    if (!appId) throw new AppAuthHandoffError("app_auth_handoff_app_resolution_failed");
    const normalized = normalizeAppIdOrUndefined(appId);
    if (!normalized) throw new AppAuthHandoffError("app_auth_handoff_invalid_app_id");
    await this.requireAsync(normalized);
    return normalized;
  }

  proxyOptions(appId: string, input: AppAuthProxyInput): Readonly<ProxyOptions> {
    return this.#proxyOptionsFor(this.require(appId), input);
  }

  /** Async proxy variant that can resolve a newly-created catalog App. */
  async proxyOptionsAsync(appId: string, input: AppAuthProxyInput): Promise<Readonly<ProxyOptions>> {
    return this.#proxyOptionsFor(await this.requireAsync(appId), input);
  }

  #proxyOptionsFor(handoff: AppAuthHandoff, input: AppAuthProxyInput): Readonly<ProxyOptions> {
    const blockedCookieNames = [
      this.registry.portalCookieName,
      ...this.registry.managedCookieNames().filter((name) => (
        !handoff.managedCookieNames.some((owned) => owned.toLowerCase() === name.toLowerCase())
      )),
    ];
    const adapterOptions = handoff.proxyOptions(input);
    const managedNames = new Set(handoff.managedCookieNames.map((name) => name.toLowerCase()));
    const rootNames = new Set((adapterOptions.rootScopedCookieNames ?? []).map((name) => name.toLowerCase()));
    for (const name of adapterOptions.rootScopedCookieNames ?? []) {
      if (!managedNames.has(name.toLowerCase())) {
        throw new AppAuthHandoffError("app_auth_handoff_unmanaged_root_cookie");
      }
    }
    for (const name of adapterOptions.httpOnlyRootScopedCookieNames ?? []) {
      if (!managedNames.has(name.toLowerCase())) {
        throw new AppAuthHandoffError("app_auth_handoff_unmanaged_http_only_cookie");
      }
      if (!rootNames.has(name.toLowerCase())) {
        throw new AppAuthHandoffError("app_auth_handoff_http_only_cookie_not_root_scoped");
      }
    }
    return {
      ...adapterOptions,
      secureRootScopedCookies: input.secureCookies || adapterOptions.secureRootScopedCookies === true,
      stripCookieNames: mergeCookieNames(blockedCookieNames, adapterOptions.stripCookieNames),
      stripResponseCookieNames: mergeCookieNames(blockedCookieNames, adapterOptions.stripResponseCookieNames),
    };
  }

  private require(appId: string): AppAuthHandoff {
    const normalized = normalizeAppIdOrUndefined(appId);
    const handoff = normalized ? (this.registry.get(normalized) ?? this.#noAuthHandoffs.get(normalized)) : undefined;
    if (!handoff) throw new AppAuthHandoffError("app_auth_handoff_not_registered");
    return handoff;
  }

  private async requireAsync(appId: string): Promise<AppAuthHandoff> {
    const normalized = normalizeAppIdOrUndefined(appId);
    const handoff = normalized
      ? (this.registry.get(normalized) ?? this.#noAuthHandoffs.get(normalized))
      : undefined;
    if (handoff) return handoff;
    if (normalized && this.#resolveNoAuthApp && await this.#resolveNoAuthApp(normalized)) {
      this.registerNoAuthApp(normalized);
      return this.#noAuthHandoffs.get(normalized)!;
    }
    throw new AppAuthHandoffError("app_auth_handoff_not_registered");
  }

  #credentialConsumer(grant: AuthCredentialGrant): AppAuthHandoff {
    const matches = this.registry.list().filter((handoff) => handoff.acceptsCredentialGrant?.(grant));
    if (matches.length === 0) throw new AppAuthHandoffError("app_auth_credential_consumer_missing");
    if (matches.length > 1) throw new AppAuthHandoffError("app_auth_credential_consumer_ambiguous");
    return matches[0]!;
  }

}

/** A safe adapter for Apps that deliberately have no downstream SSO contract. */
class NoAuthAppHandoff implements AppAuthHandoff {
  readonly managedCookieNames: readonly string[] = [];

  constructor(readonly appId: string) {}

  async onLogin(input: AppAuthLoginInput): Promise<readonly string[]> {
    const grant = input.credentialGrant;
    if (grant && input.revokeCredentialGrant) {
      await input.revokeCredentialGrant(grant, "materialize_failed");
    } else if (grant && input.revokeOpaqueCredentialGrant) {
      await input.revokeOpaqueCredentialGrant(grant, "materialize_failed");
    } else if (grant && input.revokeRefreshSession) {
      // Legacy callers can still provide a refresh-session callback.  The
      // compatibility shape is intentionally structural and has no Provider
      // or product-name branch; new adapters must use revokeCredentialGrant.
      const refreshToken = readLegacyRefreshToken(grant);
      if (refreshToken) await input.revokeRefreshSession(refreshToken, "materialize_failed");
    }
    return [];
  }

  async onLogout(_input: AppAuthLogoutInput): Promise<readonly string[]> {
    return [];
  }

  proxyOptions(_input: AppAuthProxyInput): Readonly<ProxyOptions> {
    return {};
  }
}

function normalizeAppId(value: string): string {
  const appId = value.trim().toLowerCase();
  if (!APP_ID_PATTERN.test(appId)) {
    throw new AppAuthHandoffError("app_auth_handoff_invalid_app_id");
  }
  return appId;
}

function normalizeAppIdOrUndefined(value: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const appId = value.trim().toLowerCase();
  return APP_ID_PATTERN.test(appId) ? appId : undefined;
}

function validateCookieName(value: string): string {
  const name = value.trim();
  if (!name || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name)) {
    throw new AppAuthHandoffError("app_auth_handoff_invalid_cookie_name");
  }
  return name;
}

function mergeCookieNames(
  required: readonly string[],
  additional: readonly string[] | undefined,
): readonly string[] {
  const names = new Map<string, string>();
  for (const name of [...required, ...(additional ?? [])]) {
    const trimmed = name.trim();
    if (trimmed) names.set(trimmed.toLowerCase(), trimmed);
  }
  return [...names.values()];
}

async function revokeNewGrantBestEffort(
  input: AppAuthLoginInput,
  reason: AppAuthRevocationReason,
): Promise<void> {
  const grant = input.credentialGrant;
  if (grant && input.revokeCredentialGrant) {
    try {
      await input.revokeCredentialGrant(grant, reason);
    } catch {
      console.warn(`[OpenApp auth] credential grant revocation failed during ${reason}`);
    }
    return;
  }
  if (!grant) return;
  if (!input.revokeOpaqueCredentialGrant && !input.revokeRefreshSession) return;
  try {
    if (input.revokeOpaqueCredentialGrant) {
      await input.revokeOpaqueCredentialGrant(grant, reason);
    } else {
      const refreshToken = readLegacyRefreshToken(grant);
      if (refreshToken) await input.revokeRefreshSession!(refreshToken, reason);
    }
  } catch {
    console.warn(`[OpenApp auth] opaque credential grant revocation failed during ${reason}`);
  }
}

function readLegacyRefreshToken(grant: AuthCredentialGrant): string | undefined {
  if (!grant || typeof grant !== "object") return undefined;
  const value = (grant as { refreshToken?: unknown }).refreshToken;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function clearRootCookie(name: string, secure: boolean): string {
  return [
    `${name}=`,
    "Path=/",
    "Max-Age=0",
    "SameSite=Lax",
    secure ? "Secure" : undefined,
  ].filter(Boolean).join("; ");
}
