import type { ConfigRevision, ConfigRevisionInput, ForwardingPolicy } from "./models.js";

export interface ForwardingPolicyStore {
  listForwardingPolicies(): Promise<ForwardingPolicy[]>;
  upsertForwardingPolicy(
    policy: Omit<ForwardingPolicy, "updatedAt">,
    revision?: ConfigRevisionInput,
  ): Promise<ForwardingPolicy>;
  /** Optional durable revision lookup used to invalidate caches across Portal processes. */
  getConfigRevision?(key: string): Promise<ConfigRevision | null>;
}

export interface ForwardingPolicyDefaults {
  publicBaseUrl: string;
  allowedOrigins: readonly string[];
}

export interface ForwardingPolicyCacheOptions {
  /** Maximum age of a cached policy before checking its durable revision. */
  cacheTtlMs?: number;
  /** Persistence key used for the revision row. */
  revisionKey?: string;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

export class ForwardingPolicyError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

/** Owns forwarding defaults, persistence, validation and browser-origin policy. */
export class ForwardingPolicyManager {
  readonly #store: ForwardingPolicyStore;
  readonly #defaults: ForwardingPolicyDefaults;
  readonly #cacheTtlMs: number;
  readonly #revisionKey: string;
  readonly #now: () => number;
  #current: ForwardingPolicy | undefined;
  #loadedAt: number | null = null;
  #revision: number | null = null;
  #cacheGeneration = 0;
  #refreshPromise: Promise<ForwardingPolicy> | null = null;

  constructor(
    store: ForwardingPolicyStore,
    defaults: ForwardingPolicyDefaults,
    options: ForwardingPolicyCacheOptions = {},
  ) {
    this.#store = store;
    this.#defaults = defaults;
    this.#cacheTtlMs = Math.max(0, options.cacheTtlMs ?? 5_000);
    this.#revisionKey = options.revisionKey ?? "forwarding:default";
    this.#now = options.now ?? Date.now;
  }

  async get(): Promise<ForwardingPolicy> {
    const now = this.#now();
    if (this.#current && this.#loadedAt !== null && now - this.#loadedAt < this.#cacheTtlMs) return this.#current;

    // A revision check is cheap and lets another Portal process invalidate this
    // process's cache without requiring a sticky request or an in-memory bus.
    // Keep the revision read on both sides of the policy read: otherwise an
    // older read can publish a policy snapshot while a concurrent update has
    // already advanced the durable revision.
    const generation = this.#cacheGeneration;
    let revisionBefore = this.#store.getConfigRevision
      ? await this.#store.getConfigRevision(this.#revisionKey)
      : null;
    if (generation !== this.#cacheGeneration && this.#current) return this.#current;
    if (this.#current && revisionBefore && this.#revision === revisionBefore.revision) {
      this.#loadedAt = now;
      return this.#current;
    }

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stored = (await this.#store.listForwardingPolicies())[0];
      if (generation !== this.#cacheGeneration && this.#current) return this.#current;
      if (stored) this.validateTargetBaseUrl(stored.targetBaseUrl);
      const revisionAfter = this.#store.getConfigRevision
        ? await this.#store.getConfigRevision(this.#revisionKey)
        : null;
      if (generation !== this.#cacheGeneration && this.#current) return this.#current;
      if ((revisionBefore?.revision ?? null) !== (revisionAfter?.revision ?? null)) {
        revisionBefore = revisionAfter;
        continue;
      }

      const next = stored ?? {
        id: "default",
        name: "default",
        targetBaseUrl: this.#defaults.publicBaseUrl,
        allowedHosts: [...new Set([
          new URL(this.#defaults.publicBaseUrl).origin,
          ...this.#defaults.allowedOrigins,
        ])],
        enabled: true,
        updatedBy: "system",
        updatedAt: new Date(0).toISOString(),
      };
      this.#current = next;
      this.#loadedAt = now;
      this.#revision = revisionAfter?.revision ?? null;
      return next;
    }
    throw new ForwardingPolicyError("forwarding_policy_changed_during_read", 503);
  }

  async update(
    input: Record<string, unknown>,
    actorUserId: string,
    expectedRevision?: number,
  ): Promise<ForwardingPolicy> {
    const current = await this.get();
    if (input.targetBaseUrl !== undefined && (typeof input.targetBaseUrl !== "string" || !input.targetBaseUrl.trim())) {
      throw new ForwardingPolicyError("invalid_forwarding_target");
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new ForwardingPolicyError("invalid_forwarding_enabled");
    }

    const targetBaseUrl = typeof input.targetBaseUrl === "string"
      ? input.targetBaseUrl.trim()
      : current.targetBaseUrl;
    this.validateTargetBaseUrl(targetBaseUrl);

    const allowedHosts = input.allowedHosts === undefined
      ? current.allowedHosts
      : normalizeAllowedHosts(input.allowedHosts);
    const next = {
      id: "default",
      name: "default",
      targetBaseUrl,
      allowedHosts,
      enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
      updatedBy: actorUserId,
    };
    const updated = await this.#store.upsertForwardingPolicy(next, {
      expectedRevision,
      payload: {
        targetBaseUrl: next.targetBaseUrl,
        allowedHosts: next.allowedHosts,
        enabled: next.enabled,
      },
    });
    // Publish the generation before yielding to the revision read below. Any
    // refresh that was already waiting on persistence will then discard its
    // stale snapshot instead of replacing this update in the cache.
    this.#cacheGeneration += 1;
    this.#current = updated;
    this.#loadedAt = this.#now();
    this.#revision = this.#store.getConfigRevision
      ? (await this.#store.getConfigRevision(this.#revisionKey))?.revision ?? null
      : null;
    return this.#current;
  }

  /** Force the next asynchronous read to fetch the policy from persistence. */
  invalidate(): void {
    this.#loadedAt = null;
  }

  /** Validates a draft target without persisting it, for administrator probes. */
  validateTargetBaseUrl(value: string): void {
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      throw new ForwardingPolicyError("invalid_forwarding_target");
    }
    const portal = new URL(this.#defaults.publicBaseUrl);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:")
      || target.hostname !== portal.hostname
      || (portal.protocol === "https:" && target.protocol !== "https:")
      || target.pathname !== "/"
      || Boolean(target.username || target.password || target.search || target.hash)
    ) {
      throw new ForwardingPolicyError("invalid_forwarding_target");
    }
  }

  isPortalOriginAllowed(origin: string | undefined): boolean {
    this.refreshExpiredPolicy();
    if (!origin) return true;
    if (origin === new URL(this.#defaults.publicBaseUrl).origin) return true;
    return matchesAllowedOrigin(
      origin,
      this.#current?.allowedHosts ?? this.#defaults.allowedOrigins,
    );
  }

  isInstanceOriginAllowed(origin: string | undefined, policy: ForwardingPolicy): boolean {
    return !origin || matchesAllowedOrigin(origin, policy.allowedHosts);
  }

  private refreshExpiredPolicy(): void {
    if (
      !this.#current
      || this.#loadedAt === null
      || this.#now() - this.#loadedAt < this.#cacheTtlMs
      || this.#refreshPromise
    ) return;
    this.#refreshPromise = this.get().finally(() => {
      this.#refreshPromise = null;
    });
    this.#refreshPromise.catch(() => undefined);
  }
}

function normalizeAllowedHosts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ForwardingPolicyError("allowed_hosts_required");
  const result = [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  if (result.length > 64 || result.some((item) => item.length > 255 || /[\s;]/u.test(item))) {
    throw new ForwardingPolicyError("invalid_allowed_host");
  }
  return result;
}

function matchesAllowedOrigin(origin: string, allowedHosts: readonly string[]): boolean {
  try {
    const parsed = new URL(origin);
    return allowedHosts.some((value) => {
      const candidate = value.includes("://") ? new URL(value).origin : value.toLowerCase();
      if (candidate.startsWith("*.")) {
        return parsed.hostname.toLowerCase().endsWith(candidate.slice(1));
      }
      if (candidate.includes("://")) return parsed.origin === candidate;
      return parsed.hostname.toLowerCase() === candidate.split(":")[0]!.toLowerCase();
    });
  } catch {
    return false;
  }
}
