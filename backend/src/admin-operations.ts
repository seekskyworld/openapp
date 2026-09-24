import { randomUUID } from "node:crypto";
import type { AdminStore } from "./stores-contracts.js";
import { redactSensitiveMetadata, sanitizeSensitiveText } from "./sensitive-data.js";

export type AdminOperationStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface AdminOperation {
  id: string;
  revision: number;
  type: string;
  status: AdminOperationStatus;
  progress: number;
  stage: string;
  actorUserId: string;
  resourceType: string;
  resourceId: string | null;
  requestId: string;
  idempotencyKey: string | null;
  requestFingerprint: string | null;
  retryOf: string | null;
  cancellable: boolean;
  retryable: boolean;
  result: unknown;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
}

export interface StartAdminOperation {
  type: string;
  actorUserId: string;
  resourceType: string;
  resourceId?: string | null;
  requestId?: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
  retryOf?: string;
  cancellable?: boolean;
  retryable?: boolean;
}

export interface AdminOperationStartOptions {
  /** Runs when an idempotency key resolves to an existing operation. */
  onExisting?: () => Promise<void>;
}

export class AdminOperationConflictError extends Error {
  constructor() {
    super("idempotency_key_conflict");
  }
}

/** A task can fail while still returning safe per-item results to operators. */
export class AdminOperationTaskError extends Error {
  constructor(message: string, readonly result: unknown) {
    super(message);
  }
}

export interface AdminOperationFilter {
  status?: AdminOperationStatus;
  type?: string;
  limit?: number;
}

export interface AdminOperationStore {
  saveOperation(operation: AdminOperation): Promise<void>;
  createOperation(operation: AdminOperation): Promise<{ operation: AdminOperation; created: boolean }>;
  compareAndSaveOperation(operation: AdminOperation, expectedRevision: number): Promise<AdminOperation | null>;
  recoverStaleOperations(cutoff: string, finishedAt: string): Promise<string[]>;
  withRetryLock<T>(id: string, operation: () => Promise<T>): Promise<T | null>;
  getOperation(id: string): Promise<AdminOperation | null>;
  listOperations(filter?: AdminOperationFilter): Promise<AdminOperation[]>;
  findOperationByIdempotencyKey?(actorUserId: string, idempotencyKey: string): Promise<AdminOperation | null>;
  pruneFinishedOperations?(retentionMs?: number): Promise<number>;
}

export interface AdminOperationContext {
  /** Durable operation id, available to tasks that create child records. */
  operationId: string;
  signal: AbortSignal;
  report(progress: number, stage: string): Promise<void>;
  /** Reserves an irreversible side effect against concurrent cancellation. */
  commitPoint(): Promise<void>;
}

export type AdminOperationTask = (context: AdminOperationContext) => Promise<unknown>;

export class MemoryOperationStore implements AdminOperationStore {
  readonly #operations = new Map<string, AdminOperation>();
  readonly #retryLocks = new Map<string, Promise<void>>();

  async saveOperation(operation: AdminOperation): Promise<void> {
    this.#operations.set(operation.id, structuredClone(operation));
  }

  async createOperation(operation: AdminOperation): Promise<{ operation: AdminOperation; created: boolean }> {
    if (operation.idempotencyKey) {
      const existing = [...this.#operations.values()].find((candidate) =>
        candidate.actorUserId === operation.actorUserId && candidate.idempotencyKey === operation.idempotencyKey,
      );
      if (existing) return { operation: structuredClone(existing), created: false };
    }
    this.#operations.set(operation.id, structuredClone(operation));
    return { operation: structuredClone(operation), created: true };
  }

  async compareAndSaveOperation(operation: AdminOperation, expectedRevision: number): Promise<AdminOperation | null> {
    const current = this.#operations.get(operation.id);
    if (!current || current.revision !== expectedRevision) return null;
    const updated = { ...structuredClone(operation), revision: expectedRevision + 1 };
    this.#operations.set(updated.id, updated);
    return structuredClone(updated);
  }

  async recoverStaleOperations(cutoff: string, finishedAt: string): Promise<string[]> {
    const recovered: string[] = [];
    for (const [id, current] of this.#operations) {
      if (current.status !== "queued" && current.status !== "running") continue;
      if (Date.parse(current.heartbeatAt ?? current.startedAt ?? current.createdAt) > Date.parse(cutoff)) continue;
      this.#operations.set(id, {
        ...current,
        revision: current.revision + 1,
        status: "failed",
        stage: "interrupted",
        error: "portal_restarted",
        cancellable: false,
        retryable: false,
        heartbeatAt: finishedAt,
        finishedAt,
      });
      recovered.push(id);
    }
    return recovered;
  }

  async withRetryLock<T>(id: string, operation: () => Promise<T>): Promise<T | null> {
    const previous = this.#retryLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#retryLocks.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#retryLocks.get(id) === current) this.#retryLocks.delete(id);
    }
  }

  async getOperation(id: string): Promise<AdminOperation | null> {
    return clone(this.#operations.get(id) ?? null);
  }

  async listOperations(filter: AdminOperationFilter = {}): Promise<AdminOperation[]> {
    return [...this.#operations.values()]
      .filter((operation) => !filter.status || operation.status === filter.status)
      .filter((operation) => !filter.type || operation.type === filter.type)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, Math.min(Math.max(filter.limit ?? 100, 1), 500))
      .map((operation) => clone(operation));
  }

  async findOperationByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<AdminOperation | null> {
    return clone([...this.#operations.values()].find((operation) =>
      operation.actorUserId === actorUserId && operation.idempotencyKey === idempotencyKey,
    ) ?? null);
  }

  async pruneFinishedOperations(retentionMs = OPERATION_RETENTION_MS): Promise<number> {
    const cutoff = Date.now() - Math.max(0, retentionMs);
    let removed = 0;
    for (const [id, operation] of this.#operations) {
      if (!isTerminal(operation.status)) continue;
      if (Date.parse(operation.finishedAt ?? operation.createdAt) >= cutoff) continue;
      this.#operations.delete(id);
      removed += 1;
    }
    return removed;
  }
}

/** Adapts the durable operation methods exposed by the admin store. */
export function operationStoreFromAdmin(admin: AdminStore): AdminOperationStore {
  return {
    saveOperation: (operation) => admin.saveOperation(operation),
    createOperation: (operation) => admin.createOperation(operation),
    compareAndSaveOperation: (operation, expectedRevision) => admin.compareAndSaveOperation(operation, expectedRevision),
    recoverStaleOperations: (cutoff, finishedAt) => admin.recoverStaleOperations(cutoff, finishedAt),
    withRetryLock: (id, operation) => admin.withMaintenanceLease(`operation-retry:${id}`, operation),
    getOperation: (id) => admin.getOperation(id),
    listOperations: (filter) => admin.listOperations(filter),
    findOperationByIdempotencyKey: (actorUserId, idempotencyKey) => admin.findOperationByIdempotencyKey(actorUserId, idempotencyKey),
    pruneFinishedOperations: admin.pruneFinishedOperations
      ? (retentionMs) => admin.pruneFinishedOperations!(retentionMs)
      : undefined,
  };
}

/** Runs administrator work outside the request lifecycle while preserving durable progress. */
export class AdminOperationManager {
  readonly #store: AdminOperationStore;
  readonly #controllers = new Map<string, AbortController>();
  readonly #retryTasks = new Map<string, AdminOperationTask>();
  readonly #transitionLocks = new Map<string, Promise<void>>();
  readonly #now: () => Date;

  constructor(store: AdminOperationStore, now: () => Date = () => new Date()) {
    this.#store = store;
    this.#now = now;
  }

  async start(input: StartAdminOperation, task: AdminOperationTask, options: AdminOperationStartOptions = {}): Promise<AdminOperation> {
    if (input.idempotencyKey) {
      const existing = this.#store.findOperationByIdempotencyKey
        ? await this.#store.findOperationByIdempotencyKey(input.actorUserId, input.idempotencyKey)
        : (await this.#store.listOperations({ limit: 500 }))
          .find((operation) => operation.actorUserId === input.actorUserId && operation.idempotencyKey === input.idempotencyKey) ?? null;
      if (existing) {
        assertIdempotencyMatch(existing, input);
        await options.onExisting?.();
        return existing;
      }
    }
    const createdAt = this.#now().toISOString();
    const operation: AdminOperation = {
      id: randomUUID(),
      revision: 1,
      type: input.type,
      status: "queued",
      progress: 0,
      stage: "queued",
      actorUserId: input.actorUserId,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      requestId: input.requestId ?? randomUUID(),
      idempotencyKey: input.idempotencyKey ?? null,
      requestFingerprint: input.requestFingerprint ?? null,
      retryOf: input.retryOf ?? null,
      cancellable: input.cancellable ?? false,
      retryable: input.retryable ?? false,
      result: null,
      error: null,
      createdAt,
      startedAt: null,
      heartbeatAt: null,
      finishedAt: null,
    };
    const created = await this.#store.createOperation(operation);
    if (!created.created) {
      assertIdempotencyMatch(created.operation, input);
      await options.onExisting?.();
      return created.operation;
    }
    if (operation.retryable) {
      this.#retryTasks.set(operation.id, task);
      this.#pruneRetryTasks();
    }
    queueMicrotask(() => void this.#execute(operation.id, task));
    return clone(operation);
  }

  get(id: string): Promise<AdminOperation | null> {
    return this.#store.getOperation(id);
  }

  list(filter?: AdminOperationFilter): Promise<AdminOperation[]> {
    return this.#store.listOperations(filter);
  }

  /** Marks work left by a previous process as failed instead of leaving it stuck forever. */
  async recoverInterrupted(staleAfterMs = 10 * 60_000): Promise<number> {
    const now = this.#now();
    const cutoff = new Date(now.getTime() - Math.max(0, staleAfterMs)).toISOString();
    try {
      await this.#store.pruneFinishedOperations?.();
    } catch {
      // Retention cleanup is best effort; it must not prevent stale work from
      // being marked failed and made visible to an administrator.
    }
    const recoveredIds = await this.#store.recoverStaleOperations(cutoff, now.toISOString());
    for (const id of recoveredIds) {
      this.#controllers.get(id)?.abort();
      this.#retryTasks.delete(id);
    }
    return recoveredIds.length;
  }

  async cancel(id: string): Promise<AdminOperation | null> {
    return this.#withTransitionLock(id, async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const operation = await this.#store.getOperation(id);
        if (!operation || isTerminal(operation.status)) return operation;
        if (!operation.cancellable) throw new Error("operation_not_cancellable");
        const expectedRevision = operation.revision;
        if (operation.status === "queued") {
          operation.status = "cancelled";
          operation.stage = "cancelled";
          operation.heartbeatAt = this.#now().toISOString();
          operation.finishedAt = operation.heartbeatAt;
        } else {
          if (operation.stage === "cancelling") {
            this.#controllers.get(id)?.abort();
            return operation;
          }
          operation.stage = "cancelling";
          operation.heartbeatAt = this.#now().toISOString();
        }
        const updated = await this.#store.compareAndSaveOperation(operation, expectedRevision);
        if (!updated) continue;
        this.#controllers.get(id)?.abort();
        return updated;
      }
      throw new Error("operation_state_conflict");
    });
  }

  async retry(id: string, task?: AdminOperationTask): Promise<AdminOperation> {
    const retried = await this.#store.withRetryLock(id, async () => {
      const operation = await this.#store.getOperation(id);
      if (!operation) throw new Error("operation_not_found");
      if (operation.status !== "failed" && operation.status !== "cancelled") throw new Error("operation_not_retryable");
      if (!operation.retryable && !task) throw new Error("operation_retry_unavailable");
      const retryTask = task ?? this.#retryTasks.get(id);
      if (!retryTask) {
        operation.retryable = false;
        await this.#store.compareAndSaveOperation(operation, operation.revision);
        throw new Error("operation_retry_unavailable");
      }
      const expectedRevision = operation.revision;
      const retryable = operation.retryable;
      operation.retryable = false;
      if (!await this.#store.compareAndSaveOperation(operation, expectedRevision)) {
        throw new Error("operation_retry_conflict");
      }
      try {
        const retried = await this.start({
          type: operation.type,
          actorUserId: operation.actorUserId,
          resourceType: operation.resourceType,
          resourceId: operation.resourceId,
          retryOf: operation.id,
          cancellable: operation.cancellable,
          retryable,
        }, retryTask);
        this.#retryTasks.delete(operation.id);
        return retried;
      } catch (error) {
        const latest = await this.#store.getOperation(id);
        if (latest && !latest.retryable) {
          latest.retryable = retryable;
          await this.#store.compareAndSaveOperation(latest, latest.revision);
        }
        throw error;
      }
    });
    if (retried === null) throw new Error("operation_retry_busy");
    return retried;
  }

  async #execute(id: string, task: AdminOperationTask): Promise<void> {
    const controller = new AbortController();
    let claimed = false;
    try {
      claimed = await this.#withTransitionLock(id, async () => {
        const operation = await this.#store.getOperation(id);
        if (!operation || operation.status !== "queued") return false;
        const expectedRevision = operation.revision;
        operation.status = "running";
        operation.stage = "running";
        operation.startedAt = this.#now().toISOString();
        operation.heartbeatAt = operation.startedAt;
        const updated = await this.#store.compareAndSaveOperation(operation, expectedRevision);
        if (!updated) return false;
        this.#controllers.set(id, controller);
        return true;
      });
    } catch (error) {
      await this.#markStartFailure(id, error);
      return;
    }
    if (!claimed) return;
    const heartbeatTimer = setInterval(() => { void this.#touchHeartbeat(id); }, 30_000);
    heartbeatTimer.unref();
    try {
      const result = await task({
        operationId: id,
        signal: controller.signal,
        report: async (progress, stage) => {
          await this.#withTransitionLock(id, async () => {
            const current = await this.#store.getOperation(id);
            if (!current || current.status !== "running") {
              controller.abort();
              throw new Error("operation_interrupted");
            }
            if (current.stage === "cancelling") {
              controller.abort();
              throw new Error("operation_cancelled");
            }
            const expectedRevision = current.revision;
            current.progress = clampProgress(progress);
            current.stage = boundedText(stage, 120);
            current.heartbeatAt = this.#now().toISOString();
            if (!await this.#store.compareAndSaveOperation(current, expectedRevision)) {
              controller.abort();
              throw new Error("operation_state_changed");
            }
          });
        },
        commitPoint: async () => {
          await this.#withTransitionLock(id, async () => {
            for (let attempt = 0; attempt < 10; attempt += 1) {
              const current = await this.#store.getOperation(id);
              if (controller.signal.aborted || current?.stage === "cancelling" || current?.status === "cancelled") {
                controller.abort();
                throw new Error("operation_cancelled");
              }
              if (!current || current.status !== "running") {
                controller.abort();
                throw new Error("operation_interrupted");
              }
              if (!current.cancellable && current.stage === "finalizing") return;
              const expectedRevision = current.revision;
              current.cancellable = false;
              current.stage = "finalizing";
              current.heartbeatAt = this.#now().toISOString();
              if (await this.#store.compareAndSaveOperation(current, expectedRevision)) return;
            }
            controller.abort();
            throw new Error("operation_state_changed");
          });
        },
      });
      const completed = await this.#complete(id, controller, { status: "succeeded", result });
      if (completed?.status === "succeeded" || completed?.retryable === false) this.#retryTasks.delete(id);
    } catch (error) {
      try {
        const completed = await this.#complete(id, controller, {
          status: "failed",
          error,
          ...(error instanceof AdminOperationTaskError ? { result: error.result } : {}),
        });
        if (completed?.retryable === false) this.#retryTasks.delete(id);
      } catch (persistenceError) {
        console.error("admin operation failure could not be persisted", sanitizeOperationError(persistenceError));
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.#controllers.delete(id);
    }
  }

  async #complete(
    id: string,
    controller: AbortController,
    outcome:
      | { status: "succeeded"; result: unknown }
      | { status: "failed"; error: unknown; result?: unknown },
  ): Promise<AdminOperation | null> {
    return this.#withTransitionLock(id, async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const current = await this.#store.getOperation(id);
        if (!current || isTerminal(current.status) || current.status !== "running") return current;
        const expectedRevision = current.revision;
        const passedCommitPoint = !current.cancellable && current.stage === "finalizing";
        const wasCancelled = !passedCommitPoint && (controller.signal.aborted || current.stage === "cancelling");
        current.status = wasCancelled ? "cancelled" : outcome.status;
        current.progress = current.status === "succeeded" ? 100 : current.progress;
        current.stage = current.status === "succeeded" ? "completed" : current.status;
        if (outcome.status === "succeeded" || outcome.result !== undefined) {
          current.result = redactSensitiveMetadata(outcome.result ?? null);
        }
        current.error = current.status === "failed" && outcome.status === "failed"
          ? sanitizeOperationError(outcome.error)
          : null;
        current.finishedAt = this.#now().toISOString();
        current.heartbeatAt = current.finishedAt;
        const updated = await this.#store.compareAndSaveOperation(current, expectedRevision);
        if (updated) return updated;
      }
      throw new Error("operation_state_conflict");
    });
  }

  async #touchHeartbeat(id: string): Promise<void> {
    try {
      await this.#withTransitionLock(id, async () => {
        const current = await this.#store.getOperation(id);
        const controller = this.#controllers.get(id);
        if (!current || current.status !== "running" || current.stage === "cancelling") {
          controller?.abort();
          return;
        }
        const expectedRevision = current.revision;
        current.heartbeatAt = this.#now().toISOString();
        if (!await this.#store.compareAndSaveOperation(current, expectedRevision)) controller?.abort();
      });
    } catch {
      // A later report or terminal transition can still persist the state.
    }
  }

  async #markStartFailure(id: string, error: unknown): Promise<void> {
    try {
      await this.#withTransitionLock(id, async () => {
        const current = await this.#store.getOperation(id);
        if (!current || current.status !== "queued") return;
        const expectedRevision = current.revision;
        current.status = "failed";
        current.stage = "failed";
        current.error = sanitizeOperationError(error);
        current.cancellable = false;
        current.retryable = false;
        current.finishedAt = this.#now().toISOString();
        current.heartbeatAt = current.finishedAt;
        await this.#store.compareAndSaveOperation(current, expectedRevision);
      });
    } catch {
      // The detached task must never produce an unhandled rejection if the
      // operation store is unavailable while recording its own failure.
    }
  }

  async #withTransitionLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#transitionLocks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.#transitionLocks.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#transitionLocks.get(id) === current) this.#transitionLocks.delete(id);
    }
  }

  #pruneRetryTasks(): void {
    while (this.#retryTasks.size > MAX_RETRY_TASKS) {
      const oldest = this.#retryTasks.keys().next().value as string | undefined;
      if (!oldest) return;
      this.#retryTasks.delete(oldest);
    }
  }
}

function assertIdempotencyMatch(operation: AdminOperation, input: StartAdminOperation): void {
  if (
    operation.type !== input.type
    || operation.resourceType !== input.resourceType
    || operation.resourceId !== (input.resourceId ?? null)
    || operation.requestFingerprint !== (input.requestFingerprint ?? null)
  ) throw new AdminOperationConflictError();
}

function isTerminal(status: AdminOperationStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), 99) : 0;
}

function boundedText(value: string, maximum: number): string {
  return value.trim().slice(0, maximum) || "unknown";
}

export function sanitizeOperationError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return boundedText(sanitizeSensitiveText(value, 2_000), 2_000);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

const MAX_RETRY_TASKS = 1_000;
const OPERATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
