import type { AdminOperation } from '../../admin-api';

/** Must cover the runtime adapter's 30-minute pull/load deadline. */
export const ADMIN_OPERATION_TIMEOUT_MS = 35 * 60_000;

export interface OperationPollingOptions {
  signal: AbortSignal;
  requestOperation: (id: string, signal: AbortSignal) => Promise<{ operation: AdminOperation }>;
  onUpdate: (operation: AdminOperation) => void;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export async function pollAdminOperation(id: string, options: OperationPollingOptions): Promise<AdminOperation> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const timeoutMs = options.timeoutMs ?? ADMIN_OPERATION_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const pollingController = new AbortController();
  let deadlineReached = false;

  const abortFromCaller = () => pollingController.abort(abortReason(options.signal));
  if (options.signal.aborted) abortFromCaller();
  else options.signal.addEventListener('abort', abortFromCaller, { once: true });

  const deadlineTimer = setTimeout(() => {
    deadlineReached = true;
    pollingController.abort(new DOMException('Operation polling deadline exceeded', 'TimeoutError'));
  }, timeoutMs);

  try {
    while (true) {
      throwIfAborted(pollingController.signal);
      const { operation } = await options.requestOperation(id, pollingController.signal);
      throwIfAborted(pollingController.signal);
      options.onUpdate(operation);
      if (operation.status === 'succeeded') return operation;
      if (operation.status === 'failed' || operation.status === 'cancelled') {
        throw new Error(operation.error ?? `operation_${operation.status}`);
      }

      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error('operation_timeout');
      await abortableDelay(Math.min(pollIntervalMs, remainingMs), pollingController.signal);
    }
  } catch (reason) {
    if (deadlineReached) throw new Error('operation_timeout');
    throw reason;
  } finally {
    clearTimeout(deadlineTimer);
    options.signal.removeEventListener('abort', abortFromCaller);
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Operation polling aborted', 'AbortError');
}
