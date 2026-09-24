import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { UpgradeRollout, UpgradeRolloutDetail, UpgradeRolloutItem, UpgradeRolloutItemStatus } from '../src/admin-api.ts';
import AdminDashboard from '../src/AdminDashboard.tsx';
import OperationsPanel from '../src/features/admin/OperationsPanel.tsx';
import UpgradeRolloutsSection from '../src/features/admin/UpgradeRolloutsSection.tsx';
import type { AdminView } from '../src/navigation.ts';
import {
  buttonWithText,
  clickRowAction,
  installBrowserEnvironment,
  requireElement,
  rowWithText,
  waitFor,
} from './react-test-harness.ts';

test('upgrade rollout summary renders completed items independently from successful items', async () => {
  const rollout: UpgradeRollout = {
    id: 'rollout-summary',
    status: 'running',
    useLatestVersion: true,
    requested: 4,
    completed: 2,
    succeeded: 1,
    failed: 1,
    waiting: 1,
    upgrading: 1,
    needsAttention: 0,
    createdAt: '2026-07-23T06:00:00.000Z',
    updatedAt: '2026-07-23T06:01:00.000Z',
    finishedAt: null,
  };
  const browser = installBrowserEnvironment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => jsonResponse(responseForOperationsPanel(String(input), rollout));
  let root: Root | undefined;

  try {
    const mountedRoot = createRoot(browser.container);
    root = mountedRoot;
    await act(async () => mountedRoot.render(createElement(OperationsPanel)));
    await waitFor(() => assert.match(browser.container.textContent ?? '', /完成 2 · 等待 1/u));
    assert.doesNotMatch(browser.container.textContent ?? '', /完成 1 · 等待 1/u);
  } finally {
    if (root) {
      const mountedRoot = root;
      await act(async () => mountedRoot.unmount());
    }
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('operations view keeps the task-batch section mounted during workspace loading', async () => {
  const browser = installBrowserEnvironment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Promise<Response>(() => undefined);
  let root: Root | undefined;

  try {
    const mountedRoot = createRoot(browser.container);
    root = mountedRoot;
    await act(async () => mountedRoot.render(createElement(AdminDashboard, {
      currentUser: { id: 'admin-user', email: 'admin@example.test', role: 'admin' },
      view: 'operations',
      onViewChange: () => undefined,
    })));
    assert.match(browser.container.textContent ?? '', /任务批次/u);
    assert.match(browser.container.textContent ?? '', /正在加载/u);
  } finally {
    if (root) {
      const mountedRoot = root;
      await act(async () => mountedRoot.unmount());
    }
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('administrator creates a rollout, expands polled details, and acts on waiting items', async () => {
  const browser = installBrowserEnvironment();
  browser.window.confirm = () => true;
  const originalFetch = globalThis.fetch;
  const instanceIds = ['instance-force', 'instance-continue', 'instance-cancel', 'instance-succeeded', 'instance-first-start'];
  const requests: Array<{ path: string; method: string }> = [];
  const actions: string[] = [];
  let detail = rolloutDetail(instanceIds);
  let detailReads = 0;
  let listReads = 0;

  globalThis.fetch = async (input, init: RequestInit = {}) => {
    const path = String(input);
    const method = init.method ?? 'GET';
    requests.push({ path, method });
    if (path === '/api/admin/upgrade-rollouts' && method === 'POST') {
      assert.deepEqual(JSON.parse(String(init.body)), { instanceIds, taskKind: 'image_upgrade' });
      return jsonResponse(detail);
    }
    if (path === '/api/admin/upgrade-rollouts?limit=100' && method === 'GET') {
      listReads += 1;
      return jsonResponse({ rollouts: [detail.rollout] });
    }
    if (path === `/api/admin/upgrade-rollouts/${detail.rollout.id}` && method === 'GET') {
      detailReads += 1;
      return jsonResponse(detail);
    }
    const actionRoute = path.match(/^\/api\/admin\/upgrade-rollouts\/rollout-flow\/items\/([^/]+)\/(force|continue|cancel)$/u);
    if (actionRoute && method === 'POST') {
      const instanceId = decodeURIComponent(actionRoute[1]!);
      const action = actionRoute[2]!;
      actions.push(`${instanceId}:${action}`);
      detail = applyItemAction(detail, instanceId, action as 'force' | 'continue' | 'cancel');
      return jsonResponse(detail);
    }
    return jsonResponse(workspaceResponse(path, instanceIds));
  };
  let root: Root | undefined;

  try {
    const mountedRoot = createRoot(browser.container);
    root = mountedRoot;
    await act(async () => mountedRoot.render(createElement(AdminDashboardHarness)));
    await waitFor(() => assert.match(browser.container.textContent ?? '', /5\/5 个实例/u));

    const selectAll = requireElement<HTMLInputElement>(
      browser.container,
      'input[aria-label="选择当前列表中的全部实例"]',
    );
    await act(async () => selectAll.click());
    await waitFor(() => assert.match(browser.container.textContent ?? '', /已选 5/u));
    await act(async () => buttonWithText(browser.container, '批量升级到当前镜像').click());
    await waitFor(() => assert.match(browser.container.textContent ?? '', /已提交 5 个实例，共 1 个后台任务/u));

    await act(async () => buttonWithText(browser.container, '查看进度').click());
    await waitFor(() => assert.match(browser.container.textContent ?? '', /rollout-flow/u));
    assert.match(browser.container.textContent ?? '', /完成 2 · 等待 2/u);
    await act(async () => buttonWithText(browser.container, '查看明细').click());
    await waitFor(() => assert.match(browser.container.textContent ?? '', /instance-force/u));
    assert.match(browser.container.textContent ?? '', /所有者/u);
    assert.match(browser.container.textContent ?? '', /Admin/u);
    assert.match(browser.container.textContent ?? '', /admin@example.test/u);
    assert.match(rowWithText(browser.container, 'instance-force').textContent ?? '', /存在活动 WebSocket/u);
    const firstStartRow = rowWithText(browser.container, 'instance-first-start');
    assert.match(firstStartRow.textContent ?? '', /已部署，待首次启动验证/u);
    assert.match(firstStartRow.textContent ?? '', /新版本已部署，待首次启动验证/u);
    assert.equal(firstStartRow.querySelectorAll('button').length, 0);
    assert.match(browser.container.textContent ?? '', /完成 2 · 等待 2/u);
    assert.equal(detailReads, 1);

    detail = {
      ...detail,
      items: detail.items.map((item) => item.instanceId === 'instance-force'
        ? { ...item, attemptCount: 2, blocker: 'recent_activity', lastCheckedAt: '2026-07-23T06:02:00.000Z' }
        : item),
    };
    await act(async () => browser.runInterval(10_000));
    await waitFor(() => assert.match(rowWithText(browser.container, 'instance-force').textContent ?? '', /近期仍有活动/u));
    assert.match(rowWithText(browser.container, 'instance-force').textContent ?? '', /2/u);
    assert.equal(listReads, 2);
    assert.equal(detailReads, 2);

    await clickRowAction(browser.container, 'instance-force', '强制执行');
    await waitFor(() => assert.deepEqual(actions, ['instance-force:force']));
    await clickRowAction(browser.container, 'instance-continue', '重新尝试');
    await waitFor(() => assert.deepEqual(actions, ['instance-force:force', 'instance-continue:continue']));
    await clickRowAction(browser.container, 'instance-cancel', '取消此实例任务');
    await waitFor(() => assert.deepEqual(actions, [
      'instance-force:force',
      'instance-continue:continue',
      'instance-cancel:cancel',
    ]));
    await waitFor(() => assert.match(rowWithText(browser.container, 'instance-cancel').textContent ?? '', /已取消/u));

    assert.ok(requests.some((request) => request.path === '/api/admin/upgrade-rollouts' && request.method === 'POST'));
  } finally {
    if (root) {
      const mountedRoot = root;
      await act(async () => mountedRoot.unmount());
    }
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('administrator can select actionable rollout items and apply each batch action', async () => {
  const browser = installBrowserEnvironment();
  const detail = rolloutDetail(['instance-force', 'instance-continue', 'instance-cancel', 'instance-succeeded', 'instance-first-start']);
  const actions: string[] = [];
  let root: Root | undefined;

  try {
    const mountedRoot = createRoot(browser.container);
    root = mountedRoot;
    await act(async () => mountedRoot.render(createElement(UpgradeRolloutsSection, {
      users: [{ id: 'admin-user', email: 'admin@example.test', name: 'Admin', role: 'admin' }],
      rollouts: [detail.rollout],
      details: { [detail.rollout.id]: detail },
      expandedRolloutId: detail.rollout.id,
      busyItemKeys: new Set<string>(),
      loading: false,
      onToggle: () => undefined,
      onAction: async (item: UpgradeRolloutItem, action: 'force' | 'continue' | 'revalidate' | 'cancel') => {
        actions.push(`${item.instanceId}:${action}`);
      },
    })));

    const selectAll = requireElement<HTMLInputElement>(browser.container, 'input[aria-label="选择批次中的全部可操作实例"]');
    await act(async () => selectAll.click());
    assert.equal(browser.container.querySelectorAll('input[aria-label^="选择任务项 "]:checked').length, 3);

    await act(async () => requireElement<HTMLButtonElement>(browser.container, 'button[aria-label="批量强制执行"]').click());
    assert.deepEqual(actions, [
      'instance-force:force',
      'instance-continue:force',
      'instance-cancel:force',
    ]);
    assert.equal(browser.container.querySelectorAll('input[aria-label^="选择任务项 "]:checked').length, 0);

    await act(async () => selectAll.click());
    await act(async () => requireElement<HTMLButtonElement>(browser.container, 'button[aria-label="批量继续等待或重试"]').click());
    assert.deepEqual(actions.slice(3), [
      'instance-force:continue',
      'instance-continue:continue',
    ]);

    await act(async () => selectAll.click());
    await act(async () => requireElement<HTMLButtonElement>(browser.container, 'button[aria-label="批量取消任务"]').click());
    assert.deepEqual(actions.slice(5), [
      'instance-force:cancel',
      'instance-continue:cancel',
      'instance-cancel:cancel',
    ]);
  } finally {
    if (root) {
      const mountedRoot = root;
      await act(async () => mountedRoot.unmount());
    }
    browser.restore();
  }
});

test('missing first-start proof exposes revalidate without force or rebuild actions', async () => {
  const browser = installBrowserEnvironment();
  const base = rolloutDetail(['instance-proof']);
  const detail: UpgradeRolloutDetail = {
    ...base,
    items: [{
      ...base.items[0]!,
      status: 'needs_attention',
      blocker: 'candidate_first_start_proof_missing',
      error: 'candidate_first_start_proof_missing',
      finishedAt: '2026-08-06T09:40:00.000Z',
    }],
  };
  const actions: string[] = [];
  let root: Root | undefined;

  try {
    const mountedRoot = createRoot(browser.container);
    root = mountedRoot;
    await act(async () => mountedRoot.render(createElement(UpgradeRolloutsSection, {
      users: [{ id: 'admin-user', email: 'admin@example.test', name: 'Admin', role: 'admin' }],
      rollouts: [detail.rollout],
      details: { [detail.rollout.id]: detail },
      expandedRolloutId: detail.rollout.id,
      busyItemKeys: new Set<string>(),
      loading: false,
      onToggle: () => undefined,
      onAction: async (item: UpgradeRolloutItem, action: 'force' | 'continue' | 'revalidate' | 'cancel') => {
        actions.push(`${item.instanceId}:${action}`);
      },
    })));

    const row = rowWithText(browser.container, 'instance-proof');
    assert.match(row.textContent ?? '', /首次启动验证证据缺失/u);
    assert.ok(browser.container.querySelector('td[colspan="6"]'));
    assert.equal(browser.container.querySelector('td[colspan="11"]'), null);
    assert.equal(row.querySelector('button[aria-label="强制执行"]'), null);
    assert.equal(row.querySelector('button[aria-label="重新尝试"]'), null);
    await clickRowAction(browser.container, 'instance-proof', '重新验证首次启动');
    assert.deepEqual(actions, ['instance-proof:revalidate']);

    const selectAll = requireElement<HTMLInputElement>(browser.container, 'input[aria-label="选择批次中的全部可操作实例"]');
    await act(async () => selectAll.click());
    await act(async () => requireElement<HTMLButtonElement>(browser.container, 'button[aria-label="批量重新验证首次启动"]').click());
    assert.deepEqual(actions, ['instance-proof:revalidate', 'instance-proof:revalidate']);
  } finally {
    if (root) {
      const mountedRoot = root;
      await act(async () => mountedRoot.unmount());
    }
    browser.restore();
  }
});

function AdminDashboardHarness() {
  const [view, setView] = useState<AdminView>('resources');
  return createElement(AdminDashboard, {
    currentUser: { id: 'admin-user', email: 'admin@example.test', role: 'admin' },
    view,
    onViewChange: setView,
  });
}

function responseForOperationsPanel(path: string, rollout: UpgradeRollout): unknown {
  if (path === '/api/admin/operations?limit=100') return { operations: [] };
  if (path === '/api/admin/audit?limit=100') return { events: [] };
  if (path === '/api/admin/config') {
    return {
      config: {
        databaseConfigured: true,
        wwConfigured: true,
        adminCliTokenConfigured: true,
        restartRequiredFor: [],
        runtime: { runtime: 'docker', available: true },
      },
    };
  }
  if (path === '/api/admin/upgrade-rollouts?limit=100') return { rollouts: [rollout] };
  throw new Error(`unexpected operations request: ${path}`);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function workspaceResponse(path: string, instanceIds: string[]): unknown {
  const now = '2026-07-23T06:00:00.000Z';
  if (path === '/api/admin/dashboard') {
    return {
      dashboard: {
        generatedAt: now,
        freshness: { sampleIntervalMs: 15_000, staleAfterMs: 45_000, latestSampleAt: now, stale: false, persistenceDegraded: false },
        users: { total: 1 },
        containers: { total: instanceIds.length, byStatus: { running: instanceIds.length } },
        capacity: { maxTotalInstances: 20, maxRunningInstances: 10, totalUsed: instanceIds.length, runningUsed: instanceIds.length, totalPercent: 25, runningPercent: 50 },
        resources: { cpuPercent: 1, memoryWorkingSetBytes: 1024, networkRxBytes: 100, networkTxBytes: 200, pids: 10, gpuUtilizationPercent: null },
        runtime: { id: 'docker', target: 'local', checkedAt: now, healthy: true, latencyMs: 1, error: null },
        forwarding: { enabled: true, targetBaseUrl: 'https://openapp.test', updatedAt: now },
        alerts: [],
      },
    };
  }
  if (path === '/api/admin/users') {
    return { users: [{ id: 'admin-user', email: 'admin@example.test', name: 'Admin', role: 'admin', createdAt: now }] };
  }
  if (path === '/api/admin/apps') return { apps: ['sample-app'] };
  if (path === '/api/admin/monitor/instances?limit=10000') {
    return {
      instances: instanceIds.map((id) => ({
        id,
        ownerId: 'admin-user',
        appId: 'sample-app',
        appVersionId: 'app-v1',
        imageReference: `sha256:${'a'.repeat(64)}`,
        status: 'running',
        stopReason: null,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        runtimeId: `runtime-${id}`,
        latestSampleAt: now,
        lastError: null,
        stale: false,
        metrics: null,
      })),
    };
  }
  if (path === '/api/admin/runtime') return { status: { runtime: 'docker', available: true, version: '27' } };
  if (path === '/api/admin/images') return { images: [] };
  if (path === '/api/admin/forwarding') {
    return { forwarding: { enabled: true, targetBaseUrl: 'https://openapp.test', allowedHosts: [], updatedAt: now } };
  }
  if (path === '/api/admin/instance-policy') {
    return {
      policy: {
        defaultAppId: 'sample-app',
        maxTotalInstances: 20,
        maxRunningInstances: 10,
        idleTimeoutSeconds: 3600,
        autoCreateOnFirstVisit: false,
        detectNetworkActivity: true,
        detectComputeActivity: true,
        resources: { memory: '4g', cpus: '2', pidsLimit: 512 },
        environment: {},
        configFiles: {},
      },
    };
  }
  if (path === '/api/admin/operations?limit=100') return { operations: [] };
  if (path === '/api/admin/audit?limit=100') return { events: [] };
  if (path === '/api/admin/config') {
    return {
      config: {
        databaseConfigured: true,
        wwConfigured: true,
        adminCliTokenConfigured: true,
        restartRequiredFor: [],
        runtime: { runtime: 'docker', available: true },
      },
    };
  }
  throw new Error(`unexpected dashboard request: ${path}`);
}

function rolloutDetail(instanceIds: string[]): UpgradeRolloutDetail {
  const now = '2026-07-23T06:00:00.000Z';
  const statuses: UpgradeRolloutItemStatus[] = ['waiting_for_idle', 'failed', 'queued', 'succeeded', 'awaiting_first_start'];
  const blockers = ['active_websocket', 'retry_limit_reached', null, null, 'candidate_awaiting_first_healthy_start'];
  return {
    rollout: {
      id: 'rollout-flow',
      status: 'running',
      useLatestVersion: true,
      requested: 5,
      completed: 2,
      succeeded: 1,
      failed: 1,
      waiting: 2,
      upgrading: 1,
      needsAttention: 0,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    },
    items: instanceIds.map((instanceId, position): UpgradeRolloutItem => ({
      rolloutId: 'rollout-flow',
      instanceId,
      position,
      userId: 'admin-user',
      appId: 'sample-app',
      sourceStatus: 'running',
      desiredState: 'running',
      sourceAppVersionId: 'app-v1',
      targetAppVersionId: 'app-v2',
      status: statuses[position]!,
      blocker: blockers[position]!,
      error: null,
      forceRequested: false,
      attemptCount: 1,
      nextAttemptAt: position < 3 ? '2026-07-23T06:01:00.000Z' : null,
      lastCheckedAt: now,
      startedAt: now,
      finishedAt: position >= 3 ? now : null,
      createdAt: now,
      updatedAt: now,
    })),
  };
}

function applyItemAction(
  detail: UpgradeRolloutDetail,
  instanceId: string,
  action: 'force' | 'continue' | 'revalidate' | 'cancel',
): UpgradeRolloutDetail {
  return {
    rollout: action === 'cancel'
      ? { ...detail.rollout, completed: 3, upgrading: 0, updatedAt: '2026-07-23T06:03:00.000Z' }
      : detail.rollout,
    items: detail.items.map((item) => item.instanceId !== instanceId ? item : {
      ...item,
      status: action === 'cancel' ? 'cancelled' : 'queued',
      blocker: null,
      forceRequested: action === 'force',
      updatedAt: '2026-07-23T06:03:00.000Z',
      finishedAt: action === 'cancel' ? '2026-07-23T06:03:00.000Z' : null,
    }),
  };
}
