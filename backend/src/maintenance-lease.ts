export interface MaintenanceLeaseOptions {
  /** Maximum time to wait for a lease. The default is fail-fast (0). */
  waitMs?: number;
  /** Delay between non-blocking acquisition attempts. */
  retryDelayMs?: number;
  /** Cancels waiting or the lease operation. */
  signal?: AbortSignal;
}

export function leaseWaitMs(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 0;
}

export function leaseRetryDelayMs(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? value! : 50;
}

export async function waitForLeaseRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = () => {
      cleanup();
      resolve();
    };
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("maintenance_wait_aborted"));
    };
    timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
