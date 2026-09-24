import assert from 'node:assert/strict';
import test from 'node:test';
import { adminApi, type UpgradeRolloutDetail } from '../src/admin-api.ts';

interface CapturedRequest {
  path: string;
  init: RequestInit;
}

test('upgrade rollout API methods use the rollout routes and request contract', async () => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ path: String(input), init });
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    await adminApi.createUpgradeRollout(['instance-1', 'instance-2'], 'rollout-request-1');
    await adminApi.createUpgradeRollout(['instance-3']);
    await adminApi.createTaskBatch(['instance-4'], 'apply_resource_policy', 'policy-request-1');
    await adminApi.upgradeRollouts(25);
    await adminApi.upgradeRollout('rollout/1');
    await adminApi.upgradeRolloutItem('rollout/1', 'instance/1');
    await adminApi.upgradeRolloutItemAction('rollout/1', 'instance/1', 'force');
    await adminApi.upgradeRolloutItemAction('rollout/1', 'instance/1', 'continue');
    await adminApi.upgradeRolloutItemAction('rollout/1', 'instance/1', 'revalidate');
    await adminApi.upgradeRolloutItemAction('rollout/1', 'instance/1', 'cancel');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 10);
  assert.deepEqual({
    path: requests[0]?.path,
    method: requests[0]?.init.method,
    body: requests[0]?.init.body,
    credentials: requests[0]?.init.credentials,
    contentType: new Headers(requests[0]?.init.headers).get('content-type'),
    idempotencyKey: new Headers(requests[0]?.init.headers).get('idempotency-key'),
  }, {
    path: '/api/admin/upgrade-rollouts',
    method: 'POST',
    body: '{"instanceIds":["instance-1","instance-2"],"taskKind":"image_upgrade"}',
    credentials: 'include',
    contentType: 'application/json',
    idempotencyKey: 'rollout-request-1',
  });

  const generatedKey = new Headers(requests[1]?.init.headers).get('idempotency-key');
  assert.equal(requests[1]?.path, '/api/admin/upgrade-rollouts');
  assert.equal(requests[1]?.init.body, '{"instanceIds":["instance-3"],"taskKind":"image_upgrade"}');
  assert.equal(typeof generatedKey, 'string');
  assert.ok(generatedKey && generatedKey.length > 0);

  assert.equal(requests[2]?.init.body, '{"instanceIds":["instance-4"],"taskKind":"apply_resource_policy"}');
  assert.equal(requests[3]?.path, '/api/admin/upgrade-rollouts?limit=25');
  assert.equal(requests[4]?.path, '/api/admin/upgrade-rollouts/rollout%2F1');
  assert.deepEqual(requests.slice(5).map((request) => ({
    path: request.path,
    method: request.init.method,
    body: request.init.body,
  })), [
    { path: '/api/admin/upgrade-rollouts/rollout%2F1/items/instance%2F1', method: undefined, body: undefined },
    { path: '/api/admin/upgrade-rollouts/rollout%2F1/items/instance%2F1/force', method: 'POST', body: '{}' },
    { path: '/api/admin/upgrade-rollouts/rollout%2F1/items/instance%2F1/continue', method: 'POST', body: '{}' },
    { path: '/api/admin/upgrade-rollouts/rollout%2F1/items/instance%2F1/revalidate', method: 'POST', body: '{}' },
    { path: '/api/admin/upgrade-rollouts/rollout%2F1/items/instance%2F1/cancel', method: 'POST', body: '{}' },
  ]);
});

test('admin rollout workflow creates a batch, lists it, and expands per-instance results', async () => {
  const originalFetch = globalThis.fetch;
  const requests: CapturedRequest[] = [];
  const rolloutDetail: UpgradeRolloutDetail = {
    rollout: {
      id: 'rollout-flow-1',
      status: 'running',
      useLatestVersion: true,
      requested: 2,
      completed: 1,
      succeeded: 1,
      failed: 0,
      waiting: 1,
      upgrading: 0,
      needsAttention: 0,
      createdAt: '2026-07-23T06:00:00.000Z',
      updatedAt: '2026-07-23T06:00:05.000Z',
      finishedAt: null,
    },
    items: [
      {
        rolloutId: 'rollout-flow-1',
        instanceId: 'instance-busy',
        position: 0,
        userId: 'user-1',
        appId: 'sample-app',
        sourceStatus: 'running',
        desiredState: 'running',
        sourceAppVersionId: 'app-v1',
        targetAppVersionId: 'app-v2',
        status: 'waiting_for_idle',
        blocker: 'active_websocket',
        error: null,
        forceRequested: false,
        attemptCount: 1,
        nextAttemptAt: '2026-07-23T06:01:00.000Z',
        lastCheckedAt: '2026-07-23T06:00:05.000Z',
        startedAt: '2026-07-23T06:00:00.000Z',
        finishedAt: null,
        createdAt: '2026-07-23T06:00:00.000Z',
        updatedAt: '2026-07-23T06:00:05.000Z',
      },
      {
        rolloutId: 'rollout-flow-1',
        instanceId: 'instance-idle',
        position: 1,
        userId: 'user-2',
        appId: 'sample-app',
        sourceStatus: 'stopped',
        desiredState: 'stopped',
        sourceAppVersionId: 'app-v1',
        targetAppVersionId: 'app-v2',
        status: 'succeeded',
        blocker: null,
        error: null,
        forceRequested: false,
        attemptCount: 1,
        nextAttemptAt: null,
        lastCheckedAt: '2026-07-23T06:00:04.000Z',
        startedAt: '2026-07-23T06:00:00.000Z',
        finishedAt: '2026-07-23T06:00:04.000Z',
        createdAt: '2026-07-23T06:00:00.000Z',
        updatedAt: '2026-07-23T06:00:04.000Z',
      },
    ],
  };
  const json = (value: unknown): Response => new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  globalThis.fetch = async (input, init = {}) => {
    const request = { path: String(input), init };
    requests.push(request);
    if (request.path === '/api/admin/upgrade-rollouts' && request.init.method === 'POST') {
      assert.deepEqual(JSON.parse(String(request.init.body)), {
        instanceIds: ['instance-busy', 'instance-idle'],
        taskKind: 'image_upgrade',
      });
      assert.equal(new Headers(request.init.headers).get('idempotency-key'), 'rollout-flow-request');
      return json(rolloutDetail);
    }
    if (request.path === '/api/admin/upgrade-rollouts?limit=100' && request.init.method === undefined) {
      return json({ rollouts: [rolloutDetail.rollout] });
    }
    if (request.path === '/api/admin/upgrade-rollouts/rollout-flow-1' && request.init.method === undefined) {
      return json(rolloutDetail);
    }
    throw new Error(`unexpected rollout request: ${request.path}`);
  };

  try {
    // 按管理端真实顺序提交批次、刷新列表，再展开单项明细。
    const created = await adminApi.createUpgradeRollout(['instance-busy', 'instance-idle'], 'rollout-flow-request');
    const listed = (await adminApi.upgradeRollouts()).rollouts.find((rollout) => rollout.id === created.rollout.id);
    assert.ok(listed);
    const expanded = await adminApi.upgradeRollout(listed.id);

    assert.deepEqual({
      id: listed.id,
      status: listed.status,
      requested: listed.requested,
      succeeded: listed.succeeded,
      waiting: listed.waiting,
      failed: listed.failed,
      upgrading: listed.upgrading,
      needsAttention: listed.needsAttention,
    }, {
      id: 'rollout-flow-1',
      status: 'running',
      requested: 2,
      succeeded: 1,
      waiting: 1,
      failed: 0,
      upgrading: 0,
      needsAttention: 0,
    });
    assert.deepEqual(expanded.items.map((item) => ({
      instanceId: item.instanceId,
      targetAppVersionId: item.targetAppVersionId,
      status: item.status,
      blocker: item.blocker,
      attemptCount: item.attemptCount,
      lastCheckedAt: item.lastCheckedAt,
      nextAttemptAt: item.nextAttemptAt,
    })), [
      {
        instanceId: 'instance-busy',
        targetAppVersionId: 'app-v2',
        status: 'waiting_for_idle',
        blocker: 'active_websocket',
        attemptCount: 1,
        lastCheckedAt: '2026-07-23T06:00:05.000Z',
        nextAttemptAt: '2026-07-23T06:01:00.000Z',
      },
      {
        instanceId: 'instance-idle',
        targetAppVersionId: 'app-v2',
        status: 'succeeded',
        blocker: null,
        attemptCount: 1,
        lastCheckedAt: '2026-07-23T06:00:04.000Z',
        nextAttemptAt: null,
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map((request) => ({
    path: request.path,
    method: request.init.method,
  })), [
    { path: '/api/admin/upgrade-rollouts', method: 'POST' },
    { path: '/api/admin/upgrade-rollouts?limit=100', method: undefined },
    { path: '/api/admin/upgrade-rollouts/rollout-flow-1', method: undefined },
  ]);
});
