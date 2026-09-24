import assert from 'node:assert/strict';
import test from 'node:test';
import { adminContainerBatchRequest, api } from '../src/api.ts';

test('single-instance rebuild keeps the snapshot unless upgrade is explicitly selected', async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ path: string; body: string }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ path: String(input), body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ container: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await api.adminContainerAction('instance-1', 'rebuild');
    await api.adminContainerRebuildLatest('instance-1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    { path: '/api/admin/containers/instance-1/rebuild', body: '{}' },
    { path: '/api/admin/containers/instance-1/rebuild', body: '{"useLatestVersion":true}' },
  ]);
});

test('batch upgrade maps to rebuild with useLatestVersion enabled', () => {
  assert.deepEqual(adminContainerBatchRequest(['instance-1'], 'rebuild-latest'), {
    ids: ['instance-1'],
    action: 'rebuild',
    useLatestVersion: true,
  });
});

test('ordinary batch rebuild explicitly keeps each instance image snapshot', () => {
  assert.deepEqual(adminContainerBatchRequest(['instance-1'], 'rebuild'), {
    ids: ['instance-1'],
    action: 'rebuild',
    useLatestVersion: false,
  });
});
