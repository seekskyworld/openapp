import { ProviderOperationError } from "./execution-provider.js";
import type {
  WorkspaceExecutionProjection,
} from "./workspace-execution.js";
import type { WorkspaceExecutionReconcileInput } from "./workspace-execution-manager.js";

/**
 * 受控的 desired-state reconciler。它只处理数据库已经列出的 active Workspace，
 * 不扫描或接管未知 Provider 资源；调用方显式触发 runOnce，避免服务启动时自动碰生产实例。
 */
export interface WorkspaceExecutionReconcilePort {
  reconcile(input: WorkspaceExecutionReconcileInput): Promise<WorkspaceExecutionProjection>;
}

export type ReconcileLease = <T>(
  name: string,
  operation: (signal: AbortSignal) => Promise<T>,
) => Promise<T | null>;

export type ReconcileEntryStatus = "reconciled" | "skipped" | "failed" | "busy";

export interface ReconcileEntry {
  workspaceId: string;
  status: ReconcileEntryStatus;
  attempts: number;
  reason?: string;
}

export interface ReconcileRunReport {
  scanned: number;
  selected: number;
  reconciled: number;
  skipped: number;
  failed: number;
  busy: number;
  entries: readonly ReconcileEntry[];
}

export interface WorkspaceExecutionReconcilerOptions {
  listProjections: () => Promise<WorkspaceExecutionProjection[]>;
  resolveInput: (projection: WorkspaceExecutionProjection) => Promise<WorkspaceExecutionReconcileInput>;
  execution: WorkspaceExecutionReconcilePort;
  withLease?: ReconcileLease;
  maxItems?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
}

export class WorkspaceExecutionReconciler {
  readonly #listProjections: WorkspaceExecutionReconcilerOptions["listProjections"];
  readonly #resolveInput: WorkspaceExecutionReconcilerOptions["resolveInput"];
  readonly #execution: WorkspaceExecutionReconcilePort;
  readonly #withLease: ReconcileLease;
  readonly #maxItems: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: number;
  readonly #isRetryable: (error: unknown) => boolean;

  constructor(options: WorkspaceExecutionReconcilerOptions) {
    this.#listProjections = options.listProjections;
    this.#resolveInput = options.resolveInput;
    this.#execution = options.execution;
    this.#withLease = options.withLease ?? (async (_name, operation) => operation(new AbortController().signal));
    this.#maxItems = positiveBound(options.maxItems, 100, 10_000);
    this.#maxAttempts = positiveBound(options.maxAttempts, 3, 10);
    this.#retryDelayMs = positiveBound(options.retryDelayMs, 100, 60_000);
    this.#isRetryable = options.isRetryable ?? defaultRetryable;
  }

  async runOnce(signal?: AbortSignal): Promise<ReconcileRunReport> {
    const empty = (): ReconcileRunReport => ({
      scanned: 0,
      selected: 0,
      reconciled: 0,
      skipped: 0,
      failed: 0,
      busy: 0,
      entries: [],
    });
    const report = await this.#withLease("workspace-execution-reconciler", async (leaseSignal) => {
      const combinedSignal = signal ? AbortSignal.any([signal, leaseSignal]) : leaseSignal;
      combinedSignal.throwIfAborted();
      const projections = (await this.#listProjections())
        .slice()
        .sort((left, right) => left.workspace.id.localeCompare(right.workspace.id));
      const entries: ReconcileEntry[] = [];
      let selected = 0;
      let reconciled = 0;
      let skipped = 0;
      let failed = 0;
      let busy = 0;
      for (const projection of projections.slice(0, this.#maxItems)) {
        combinedSignal.throwIfAborted();
        if (!needsReconciliation(projection)) {
          skipped += 1;
          entries.push({ workspaceId: projection.workspace.id, status: "skipped", attempts: 0, reason: skipReason(projection) });
          continue;
        }
        selected += 1;
        const result = await this.#withLease(
          `workspace-execution-reconcile:${projection.workspace.id}`,
          (workspaceSignal) => this.#reconcileOne(projection, AbortSignal.any([combinedSignal, workspaceSignal])),
        );
        if (result === null) {
          busy += 1;
          entries.push({ workspaceId: projection.workspace.id, status: "busy", attempts: 0, reason: "lease_busy" });
        } else if (result.status === "reconciled") {
          reconciled += 1;
          entries.push(result);
        } else {
          failed += 1;
          entries.push(result);
        }
      }
      return {
        scanned: projections.length,
        selected,
        reconciled,
        skipped,
        failed,
        busy,
        entries,
      } satisfies ReconcileRunReport;
    });
    return report ?? empty();
  }

  async #reconcileOne(
    projection: WorkspaceExecutionProjection,
    signal: AbortSignal,
  ): Promise<ReconcileEntry> {
    let attempts = 0;
    let lastError: unknown;
    while (attempts < this.#maxAttempts) {
      attempts += 1;
      signal.throwIfAborted();
      try {
        const input = await this.#resolveInput(projection);
        signal.throwIfAborted();
        await this.#execution.reconcile({ ...input, signal });
        return { workspaceId: projection.workspace.id, status: "reconciled", attempts };
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        lastError = error;
        if (!this.#isRetryable(error) || attempts >= this.#maxAttempts) break;
        await delay(this.#retryDelayMs * attempts, signal);
      }
    }
    return {
      workspaceId: projection.workspace.id,
      status: "failed",
      attempts,
      reason: errorCode(lastError),
    };
  }
}

export function needsReconciliation(projection: WorkspaceExecutionProjection): boolean {
  if (projection.workspace.status !== "active" || projection.execution.role !== "active") return false;
  if (["failed", "inconsistent", "rolled_back"].includes(projection.execution.transactionStatus)) return false;
  if (["requested", "progressing"].includes(projection.execution.transactionStatus)) return true;
  if (projection.execution.desiredGeneration > projection.execution.deployedGeneration) return true;
  if (projection.execution.desiredState === "running") return projection.execution.observedState !== "running";
  return projection.execution.observedState !== "stopped" && projection.execution.observedState !== "absent";
}

function skipReason(projection: WorkspaceExecutionProjection): string {
  if (projection.workspace.status !== "active") return `workspace_${projection.workspace.status}`;
  if (projection.execution.role !== "active") return `execution_${projection.execution.role}`;
  if (["failed", "inconsistent", "rolled_back"].includes(projection.execution.transactionStatus)) {
    return `transaction_${projection.execution.transactionStatus}`;
  }
  return "already_converged";
}

function defaultRetryable(error: unknown): boolean {
  if (error instanceof ProviderOperationError) return error.failureClass === "transient";
  if (error && typeof error === "object" && "retryable" in error) {
    return (error as { retryable?: unknown }).retryable === true;
  }
  return false;
}

function errorCode(error: unknown): string {
  if (error instanceof ProviderOperationError) return error.code;
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "workspace_reconcile_failed";
}

function positiveBound(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! > 0 && value! <= maximum ? value! : fallback;
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason instanceof Error ? signal.reason : new Error("workspace_reconcile_aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}
