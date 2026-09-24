import assert from 'node:assert/strict';
import test from 'node:test';
import { pollAdminOperation } from '../src/features/admin/operation-polling.ts';
import type { AdminOperation } from '../src/admin-api.ts';

function operation(status: AdminOperation['status']): AdminOperation {
  return {
    id: 'operation-1',
    revision: 1,
    type: 'image.pull',
    status,
    progress: status === 'succeeded' ? 100 : 10,
    stage: status,
    actorUserId: 'admin-1',
    resourceType: 'image',
    resourceId: null,
    requestId: 'request-1',
    retryOf: null,
    cancellable: true,
    retryable: false,
    result: null,
    error: null,
    createdAt: new Date(0).toISOString(),
    startedAt: null,
    heartbeatAt: null,
    finishedAt: null,
  };
}

test('aborting while waiting stops the poll timer before another request', async () => {
  const controller = new AbortController();
  let requests = 0;
  const pending = pollAdminOperation('operation-1', {
    signal: controller.signal,
    pollIntervalMs: 25,
    timeoutMs: 100,
    requestOperation: async () => {
      requests += 1;
      return { operation: operation('running') };
    },
    onUpdate: () => undefined,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new DOMException('component unmounted', 'AbortError'));

  await assert.rejects(pending, (reason: unknown) => reason instanceof DOMException && reason.name === 'AbortError');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(requests, 1);
});

test('the deadline aborts an in-flight operation request', async () => {
  const controller = new AbortController();
  let requestWasAborted = false;
  const pending = pollAdminOperation('operation-1', {
    signal: controller.signal,
    pollIntervalMs: 10,
    timeoutMs: 20,
    requestOperation: async (_id, signal) => new Promise((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('hung_request_guard')), 100);
      signal.addEventListener('abort', () => {
        clearTimeout(guard);
        requestWasAborted = true;
        reject(signal.reason);
      }, { once: true });
    }),
    onUpdate: () => undefined,
  });

  await assert.rejects(pending, /operation_timeout/u);
  assert.equal(requestWasAborted, true);
});

test('sequential polls clean up independently', async () => {
  for (const id of ['operation-1', 'operation-2']) {
    const controller = new AbortController();
    let requests = 0;
    const result = await pollAdminOperation(id, {
      signal: controller.signal,
      pollIntervalMs: 1,
      timeoutMs: 100,
      requestOperation: async () => {
        requests += 1;
        return { operation: operation(requests === 1 ? 'running' : 'succeeded') };
      },
      onUpdate: () => undefined,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(requests, 2);
    assert.equal(controller.signal.aborted, false);
  }
});
