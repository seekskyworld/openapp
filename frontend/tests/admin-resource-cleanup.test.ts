import assert from 'node:assert/strict';
import test from 'node:test';
import { adminResourceCleanupRequest } from '../src/api.ts';

test('resource cleanup posts the current rollback retention and forwards cancellation', () => {
  const controller = new AbortController();
  assert.deepEqual(adminResourceCleanupRequest(3, controller.signal), {
    path: '/api/admin/resource-cleanup',
    init: {
      method: 'POST',
      body: '{"keepPrevious":3}',
      signal: controller.signal,
    },
  });
});
