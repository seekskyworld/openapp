/**
 * 配额准入的纯领域实现。它按 global/tenant/user/provider 四个可组合作用域
 * 计算声明资源，并用 reservation id 保证重复请求幂等；持久化实现可复用同一合同。
 * 默认不会被 Portal 自动启用，避免在没有 durable ledger 时把内存状态误当成生产配额真相。
 */

export type QuotaDimension =
  | "instances"
  | "runningInstances"
  | "cpuMillis"
  | "memoryBytes"
  | "pids"
  | "volumeBytes"
  | "concurrentBuilds"
  | "rolloutConcurrency";

export type QuotaScopeKind = "global" | "tenant" | "user" | "provider";

export interface QuotaLimits {
  instances?: number;
  runningInstances?: number;
  cpuMillis?: number;
  memoryBytes?: number;
  pids?: number;
  volumeBytes?: number;
  concurrentBuilds?: number;
  rolloutConcurrency?: number;
}

export interface QuotaPolicy {
  global?: QuotaLimits;
  tenants?: Readonly<Record<string, QuotaLimits>>;
  users?: Readonly<Record<string, QuotaLimits>>;
  providers?: Readonly<Record<string, QuotaLimits>>;
}

export interface QuotaReservationRequest {
  reservationId: string;
  userId: string;
  tenantId?: string;
  providerId: string;
  desiredState: "running" | "stopped";
  cpuMillis: number;
  memoryBytes: number;
  pidsLimit: number;
  volumeBytes?: number;
  buildSlots?: number;
  rolloutSlots?: number;
}

export interface QuotaReservation {
  id: string;
  request: Readonly<QuotaReservationRequest>;
  reservedAt: string;
}

export type QuotaDecision =
  | { status: "admitted"; reservationId: string }
  | {
      status: "denied";
      reservationId: string;
      code: "quota_exceeded";
      dimension: QuotaDimension;
      scope: string;
      retryable: false;
    }
  | {
      status: "unavailable";
      reservationId: string;
      code: "quota_unavailable";
      retryable: true;
    };

export class QuotaAdmissionError extends Error {
  readonly status: 409 | 503;

  constructor(
    readonly code: "quota_exceeded" | "quota_unavailable" | "quota_reservation_conflict" | "quota_reservation_not_found",
    readonly dimension?: QuotaDimension,
    readonly scope?: string,
    readonly retryable = code === "quota_unavailable",
  ) {
    super(code);
    this.name = "QuotaAdmissionError";
    this.status = retryable ? 503 : 409;
  }
}

export interface QuotaAdmission {
  admit(request: QuotaReservationRequest): Promise<QuotaDecision>;
  reserve(request: QuotaReservationRequest): Promise<QuotaReservation>;
  transition(reservationId: string, desiredState: "running" | "stopped"): Promise<boolean>;
  release(reservationId: string): Promise<boolean>;
}

const DIMENSIONS: readonly QuotaDimension[] = [
  "instances",
  "runningInstances",
  "cpuMillis",
  "memoryBytes",
  "pids",
  "volumeBytes",
  "concurrentBuilds",
  "rolloutConcurrency",
];

/** 可用于本地验证和 staging 的串行内存准入；生产持久化实现必须复刻同一语义。 */
export class InMemoryQuotaAdmission implements QuotaAdmission {
  readonly #policy: QuotaPolicy;
  readonly #now: () => Date;
  readonly #reservations = new Map<string, QuotaReservationRequest>();
  #available: boolean;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { policy?: QuotaPolicy; now?: () => Date; available?: boolean } = {}) {
    this.#policy = normalizePolicy(options.policy ?? {});
    this.#now = options.now ?? (() => new Date());
    this.#available = options.available ?? true;
  }

  setAvailable(available: boolean): void {
    this.#available = available;
  }

  async admit(request: QuotaReservationRequest): Promise<QuotaDecision> {
    return this.#enqueue(async () => {
      const normalized = normalizeRequest(request);
      const existing = this.#reservations.get(normalized.reservationId);
      if (existing) {
        if (!sameRequest(existing, normalized)) throw new QuotaAdmissionError("quota_reservation_conflict");
        return { status: "admitted", reservationId: normalized.reservationId };
      }
      if (!this.#available) {
        return { status: "unavailable", reservationId: normalized.reservationId, code: "quota_unavailable", retryable: true };
      }
      const denial = this.#findDenial(normalized);
      if (denial) {
        return {
          status: "denied",
          reservationId: normalized.reservationId,
          code: "quota_exceeded",
          dimension: denial.dimension,
          scope: denial.scope,
          retryable: false,
        };
      }
      return { status: "admitted", reservationId: normalized.reservationId };
    });
  }

  async reserve(request: QuotaReservationRequest): Promise<QuotaReservation> {
    return this.#enqueue(async () => {
      const normalized = normalizeRequest(request);
      const existing = this.#reservations.get(normalized.reservationId);
      if (existing) {
        if (!sameRequest(existing, normalized)) throw new QuotaAdmissionError("quota_reservation_conflict");
        return reservationSnapshot(existing, this.#now());
      }
      if (!this.#available) throw new QuotaAdmissionError("quota_unavailable");
      const denial = this.#findDenial(normalized);
      if (denial) throw new QuotaAdmissionError("quota_exceeded", denial.dimension, denial.scope);
      this.#reservations.set(normalized.reservationId, normalized);
      return reservationSnapshot(normalized, this.#now());
    });
  }

  async transition(reservationId: string, desiredState: "running" | "stopped"): Promise<boolean> {
    return this.#enqueue(async () => {
      const current = this.#reservations.get(reservationId);
      if (!current) return false;
      if (current.desiredState === desiredState) return true;
      if (!this.#available) throw new QuotaAdmissionError("quota_unavailable");
      const next = { ...current, desiredState };
      const denial = this.#findDenial(next, reservationId);
      if (denial) throw new QuotaAdmissionError("quota_exceeded", denial.dimension, denial.scope);
      this.#reservations.set(reservationId, next);
      return true;
    });
  }

  async release(reservationId: string): Promise<boolean> {
    return this.#enqueue(async () => this.#reservations.delete(reservationId));
  }

  /** 返回脱敏的当前使用量，供监控或测试读取；不返回用户请求原文。 */
  snapshot(): Readonly<Record<string, Readonly<Record<QuotaDimension, number>>>> {
    const result: Record<string, Record<QuotaDimension, number>> = {};
    for (const reservation of this.#reservations.values()) {
      for (const scope of scopesFor(reservation, this.#policy)) {
        const usage = result[scope.key] ?? emptyUsage();
        const contribution = contributionFor(reservation);
        for (const dimension of DIMENSIONS) usage[dimension] += contribution[dimension];
        result[scope.key] = usage;
      }
    }
    return structuredClone(result);
  }

  #findDenial(
    request: QuotaReservationRequest,
    excludingReservationId?: string,
  ): { dimension: QuotaDimension; scope: string } | null {
    const contribution = contributionFor(request);
    for (const scope of scopesFor(request, this.#policy)) {
      const usage = this.#usageFor(scope.key, excludingReservationId);
      for (const dimension of DIMENSIONS) {
        const limit = scope.limits[dimension];
        if (limit !== undefined && usage[dimension] + contribution[dimension] > limit) {
          return { dimension, scope: scope.key };
        }
      }
    }
    return null;
  }

  #usageFor(scopeKey: string, excludingReservationId?: string): Record<QuotaDimension, number> {
    const usage = emptyUsage();
    for (const reservation of this.#reservations.values()) {
      if (reservation.reservationId === excludingReservationId) continue;
      if (!scopesFor(reservation, this.#policy).some((scope) => scope.key === scopeKey)) continue;
      const contribution = contributionFor(reservation);
      for (const dimension of DIMENSIONS) usage[dimension] += contribution[dimension];
    }
    return usage;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation, operation);
    this.#tail = next.then(() => undefined, () => undefined);
    return next;
  }
}

function normalizeRequest(request: QuotaReservationRequest): QuotaReservationRequest {
  if (!request || typeof request !== "object") throw new QuotaAdmissionError("quota_reservation_conflict");
  const reservationId = identifier(request.reservationId);
  const userId = identifier(request.userId);
  const providerId = identifier(request.providerId);
  if (!reservationId || !userId || !providerId) throw new QuotaAdmissionError("quota_reservation_conflict");
  if (request.desiredState !== "running" && request.desiredState !== "stopped") {
    throw new QuotaAdmissionError("quota_reservation_conflict");
  }
  const normalized: QuotaReservationRequest = {
    reservationId,
    userId,
    providerId,
    desiredState: request.desiredState,
    cpuMillis: positiveInteger(request.cpuMillis),
    memoryBytes: positiveInteger(request.memoryBytes),
    pidsLimit: positiveInteger(request.pidsLimit),
  };
  const tenantId = request.tenantId === undefined ? undefined : identifier(request.tenantId);
  if (request.tenantId !== undefined && !tenantId) throw new QuotaAdmissionError("quota_reservation_conflict");
  if (tenantId) normalized.tenantId = tenantId;
  if (request.volumeBytes !== undefined) normalized.volumeBytes = nonNegativeInteger(request.volumeBytes);
  if (request.buildSlots !== undefined) normalized.buildSlots = nonNegativeInteger(request.buildSlots);
  if (request.rolloutSlots !== undefined) normalized.rolloutSlots = nonNegativeInteger(request.rolloutSlots);
  return normalized;
}

function normalizePolicy(policy: QuotaPolicy): QuotaPolicy {
  const normalizeLimits = (limits: QuotaLimits | undefined): QuotaLimits | undefined => {
    if (limits === undefined) return undefined;
    const result: QuotaLimits = {};
    for (const dimension of DIMENSIONS) {
      const value = limits[dimension];
      if (value !== undefined) result[dimension] = nonNegativeInteger(value);
    }
    return result;
  };
  const normalizeMap = (values: Readonly<Record<string, QuotaLimits>> | undefined) => {
    if (!values) return undefined;
    const result: Record<string, QuotaLimits> = {};
    for (const [key, limits] of Object.entries(values)) {
      const normalizedKey = identifier(key);
      if (!normalizedKey) throw new QuotaAdmissionError("quota_reservation_conflict");
      result[normalizedKey] = normalizeLimits(limits)!;
    }
    return result;
  };
  return {
    global: normalizeLimits(policy.global),
    tenants: normalizeMap(policy.tenants),
    users: normalizeMap(policy.users),
    providers: normalizeMap(policy.providers),
  };
}

function scopesFor(request: QuotaReservationRequest, policy: QuotaPolicy): Array<{ key: string; limits: QuotaLimits }> {
  const scopes: Array<{ key: string; limits: QuotaLimits }> = [];
  if (policy.global) scopes.push({ key: "global", limits: policy.global });
  if (request.tenantId && policy.tenants?.[request.tenantId]) {
    scopes.push({ key: `tenant:${request.tenantId}`, limits: policy.tenants[request.tenantId]! });
  }
  if (policy.users?.[request.userId]) {
    scopes.push({ key: `user:${request.userId}`, limits: policy.users[request.userId]! });
  }
  if (policy.providers?.[request.providerId]) {
    scopes.push({ key: `provider:${request.providerId}`, limits: policy.providers[request.providerId]! });
  }
  return scopes;
}

function contributionFor(request: QuotaReservationRequest): Record<QuotaDimension, number> {
  return {
    instances: 1,
    runningInstances: request.desiredState === "running" ? 1 : 0,
    cpuMillis: request.cpuMillis,
    memoryBytes: request.memoryBytes,
    pids: request.pidsLimit,
    volumeBytes: request.volumeBytes ?? 0,
    concurrentBuilds: request.buildSlots ?? 0,
    rolloutConcurrency: request.rolloutSlots ?? 0,
  };
}

function emptyUsage(): Record<QuotaDimension, number> {
  return {
    instances: 0,
    runningInstances: 0,
    cpuMillis: 0,
    memoryBytes: 0,
    pids: 0,
    volumeBytes: 0,
    concurrentBuilds: 0,
    rolloutConcurrency: 0,
  };
}

function reservationSnapshot(request: QuotaReservationRequest, now: Date): QuotaReservation {
  return {
    id: request.reservationId,
    request: structuredClone(request),
    reservedAt: now.toISOString(),
  };
}

function sameRequest(left: QuotaReservationRequest, right: QuotaReservationRequest): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function identifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new QuotaAdmissionError("quota_reservation_conflict");
  return value as number;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new QuotaAdmissionError("quota_reservation_conflict");
  return value as number;
}
