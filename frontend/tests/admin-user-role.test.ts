import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AdminDashboard from '../src/AdminDashboard.tsx';
import {
  buttonWithText,
  installBrowserEnvironment,
  requireElement,
  waitFor,
} from './react-test-harness.ts';

test('super administrator sets a missing local password and then creates another super administrator', async () => {
  const browser = installBrowserEnvironment();
  const originalFetch = globalThis.fetch;
  const roleRequests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init: RequestInit = {}) => {
    const path = String(input);
    if (path === '/api/admin/users/target-user/role' && init.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      roleRequests.push(body);
      if (body.password === undefined) return errorResponse(409, 'local_credentials_required');
      return jsonResponse({
        user: { id: 'target-user', email: 'target@example.test', role: 'super_admin', createdAt: NOW },
      });
    }
    return jsonResponse(workspaceResponse(path));
  };
  let root: Root | undefined;

  try {
    const mountedRoot = createRoot(browser.container);
    root = mountedRoot;
    await act(async () => mountedRoot.render(createElement(AdminDashboard, {
      view: 'resources',
      onViewChange: () => undefined,
      currentUser: { id: 'super-user', email: 'super@example.test', role: 'super_admin' },
    })));
    await waitFor(() => assert.match(browser.container.textContent ?? '', /target@example\.test/u));

    const row = rowContainingText(browser.container, 'target@example.test');
    const roleSelect = requireElement<HTMLSelectElement>(row, 'select');
    await act(async () => setSelectValue(browser.window, roleSelect, 'super_admin'));
    await waitFor(() => assert.match(browser.container.textContent ?? '', /设置管理账号密码/u));
    assert.deepEqual(roleRequests, [{ expectedRole: 'user', role: 'super_admin' }]);

    await act(async () => buttonWithText(requireElement<HTMLElement>(browser.container, '[role="dialog"]'), '取消').click());
    assert.equal(browser.container.querySelector('[role="dialog"]'), null);
    assert.equal(requireElement<HTMLSelectElement>(rowContainingText(browser.container, 'target@example.test'), 'select').value, 'user');
    assert.match(browser.container.textContent ?? '', /未设置密码，管理角色调整未完成/u);
    assert.deepEqual(roleRequests, [{ expectedRole: 'user', role: 'super_admin' }]);

    await act(async () => setSelectValue(
      browser.window,
      requireElement<HTMLSelectElement>(rowContainingText(browser.container, 'target@example.test'), 'select'),
      'super_admin',
    ));
    await waitFor(() => assert.match(browser.container.textContent ?? '', /设置管理账号密码/u));
    const dialog = requireElement<HTMLElement>(browser.container, '[role="dialog"]');
    const passwordInputs = [...dialog.querySelectorAll<HTMLInputElement>('input[type="password"]')];
    assert.equal(passwordInputs.length, 2);
    await act(async () => {
      setInputValue(browser.window, passwordInputs[0]!, 'target administrator password');
      setInputValue(browser.window, passwordInputs[1]!, 'target administrator password');
    });
    await act(async () => buttonWithText(dialog, '设置并设为超级管理员').click());

    await waitFor(() => assert.deepEqual(roleRequests, [
      { expectedRole: 'user', role: 'super_admin' },
      { expectedRole: 'user', role: 'super_admin' },
      { expectedRole: 'user', role: 'super_admin', password: 'target administrator password' },
    ]));
    await waitFor(() => assert.equal(browser.container.querySelector('[role="dialog"]'), null));
    assert.equal(requireElement<HTMLSelectElement>(rowContainingText(browser.container, 'target@example.test'), 'select').value, 'super_admin');
    assert.match(browser.container.textContent ?? '', /target@example\.test 的角色已更新/u);
  } finally {
    if (root) {
      const mountedRoot = root;
      await act(async () => mountedRoot.unmount());
    }
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

test('administrator sees account roles as read only and can create members only', async () => {
  const browser = installBrowserEnvironment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => jsonResponse(workspaceResponse(String(input)));
  let root: Root | undefined;

  try {
    const mountedRoot = createRoot(browser.container);
    root = mountedRoot;
    await act(async () => mountedRoot.render(createElement(AdminDashboard, {
      view: 'resources',
      onViewChange: () => undefined,
      currentUser: { id: 'admin-user', email: 'admin@example.test', role: 'admin' },
    })));
    await waitFor(() => assert.match(browser.container.textContent ?? '', /target@example\.test/u));

    assert.equal(rowContainingText(browser.container, 'target@example.test').querySelector('select'), null);
    assert.equal(rowContainingText(browser.container, 'super@example.test').querySelector('select'), null);

    await act(async () => buttonWithText(browser.container, '创建用户').click());
    const dialog = requireElement<HTMLElement>(browser.container, '[role="dialog"]');
    assert.equal(dialog.querySelector('select'), null);
    assert.match(dialog.textContent ?? '', /账号角色成员/u);
  } finally {
    if (root) {
      const mountedRoot = root;
      await act(async () => mountedRoot.unmount());
    }
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});

const NOW = '2026-07-31T10:00:00.000Z';

function workspaceResponse(path: string): unknown {
  if (path === '/api/admin/dashboard') {
    return {
      dashboard: {
        generatedAt: NOW,
        freshness: { sampleIntervalMs: 15_000, staleAfterMs: 45_000, latestSampleAt: NOW, stale: false, persistenceDegraded: false },
        users: { total: 2 },
        containers: { total: 0, byStatus: {} },
        capacity: { maxTotalInstances: 20, maxRunningInstances: 10, totalUsed: 0, runningUsed: 0, totalPercent: 0, runningPercent: 0 },
        resources: { cpuPercent: 0, memoryWorkingSetBytes: 0, networkRxBytes: 0, networkTxBytes: 0, pids: 0, gpuUtilizationPercent: null },
        runtime: { id: 'docker', target: 'local', checkedAt: NOW, healthy: true, latencyMs: 1, error: null },
        forwarding: { enabled: true, targetBaseUrl: 'https://openapp.test', updatedAt: NOW },
        alerts: [],
      },
    };
  }
  if (path === '/api/admin/users') {
    return {
      users: [
        { id: 'admin-user', email: 'admin@example.test', role: 'admin', createdAt: NOW },
        { id: 'super-user', email: 'super@example.test', role: 'super_admin', createdAt: NOW },
        { id: 'target-user', email: 'target@example.test', role: 'user', createdAt: NOW },
      ],
    };
  }
  if (path === '/api/admin/apps') return { apps: ['sample-app'] };
  if (path === '/api/admin/monitor/instances?limit=10000') return { instances: [] };
  if (path === '/api/admin/runtime') return { status: { runtime: 'docker', available: true } };
  if (path === '/api/admin/images') return { images: [] };
  if (path === '/api/admin/forwarding') {
    return { forwarding: { enabled: true, allowedHosts: [], targetBaseUrl: 'https://openapp.test', updatedAt: NOW } };
  }
  if (path === '/api/admin/instance-policy') {
    return {
      policy: {
        autoCreateOnFirstVisit: true,
        defaultAppId: 'sample-app',
        maxTotalInstances: 20,
        maxRunningInstances: 10,
        autoStartOnEnter: true,
        autoWakeOnRequest: true,
        blockAutoWakeAfterManualStop: true,
        idleStopMinutes: 30,
        detectNetworkActivity: true,
        detectComputeActivity: true,
        resources: { memory: '2g', cpus: '1', pidsLimit: 256 },
        environment: {},
        configFiles: {},
      },
    };
  }
  throw new Error(`unexpected admin request: ${path}`);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function setInputValue(browserWindow: Window & typeof globalThis, input: HTMLInputElement, value: string): void {
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(browserWindow.HTMLInputElement.prototype, 'value')?.set;
  assert.ok(setter);
  setter.call(input, value);
  const propertyChange = new browserWindow.Event('propertychange', { bubbles: true });
  Object.defineProperty(propertyChange, 'propertyName', { value: 'value' });
  input.dispatchEvent(propertyChange);
  input.dispatchEvent(new browserWindow.Event('input', { bubbles: true }));
  input.dispatchEvent(new browserWindow.Event('change', { bubbles: true }));
}

function setSelectValue(browserWindow: Window & typeof globalThis, select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(browserWindow.HTMLSelectElement.prototype, 'value')?.set;
  assert.ok(setter);
  setter.call(select, value);
  select.dispatchEvent(new browserWindow.Event('change', { bubbles: true }));
}

function rowContainingText(container: Element, text: string): HTMLTableRowElement {
  const row = [...container.querySelectorAll('tr')].find((candidate) => candidate.textContent?.includes(text));
  assert.ok(row instanceof window.HTMLTableRowElement, `missing row containing: ${text}`);
  return row;
}
