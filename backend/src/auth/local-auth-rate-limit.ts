export type LocalAuthOperation = "login" | "register" | "password-setup" | "password-change" | "external-password-code" | "external-password-change";

export interface LocalAuthRateLimitPolicy {
  readonly windowMs: number;
  readonly attemptsPerSource: number;
  readonly attemptsPerAccount: number;
}

export type LocalAuthRateLimitPolicies = Record<LocalAuthOperation, LocalAuthRateLimitPolicy>;

export const DEFAULT_LOCAL_AUTH_RATE_LIMIT_POLICIES: LocalAuthRateLimitPolicies = {
  login: { windowMs: 15 * 60_000, attemptsPerSource: 60, attemptsPerAccount: 10 },
  register: { windowMs: 60 * 60_000, attemptsPerSource: 20, attemptsPerAccount: 3 },
  "password-setup": { windowMs: 15 * 60_000, attemptsPerSource: 30, attemptsPerAccount: 5 },
  "password-change": { windowMs: 15 * 60_000, attemptsPerSource: 60, attemptsPerAccount: 10 },
  "external-password-code": { windowMs: 15 * 60_000, attemptsPerSource: 30, attemptsPerAccount: 5 },
  "external-password-change": { windowMs: 15 * 60_000, attemptsPerSource: 30, attemptsPerAccount: 10 },
};

interface AttemptBucket {
  count: number;
  expiresAt: number;
}

export class LocalAuthRateLimiter {
  readonly #buckets = new Map<string, AttemptBucket>();
  #attemptsSinceCleanup = 0;

  constructor(
    private readonly policies = DEFAULT_LOCAL_AUTH_RATE_LIMIT_POLICIES,
    private readonly now: () => number = Date.now,
  ) {}

  consume(operation: LocalAuthOperation, source: string, account: string): boolean {
    const now = this.now();
    if (++this.#attemptsSinceCleanup >= 256) {
      for (const [key, bucket] of this.#buckets) {
        if (bucket.expiresAt <= now) this.#buckets.delete(key);
      }
      this.#attemptsSinceCleanup = 0;
    }
    const policy = this.policies[operation];
    const dimensions = [
      { key: `${operation}:source:${source.trim() || "unknown"}`, limit: policy.attemptsPerSource },
      { key: `${operation}:account:${account.trim().toLowerCase()}`, limit: policy.attemptsPerAccount },
    ];
    const buckets = dimensions.map(({ key }) => {
      const current = this.#buckets.get(key);
      return current && current.expiresAt > now
        ? current
        : { count: 0, expiresAt: now + policy.windowMs };
    });
    if (buckets.some((bucket, index) => bucket.count >= dimensions[index]!.limit)) return false;
    dimensions.forEach(({ key }, index) => {
      const bucket = buckets[index]!;
      this.#buckets.set(key, { ...bucket, count: bucket.count + 1 });
    });
    return true;
  }
}
