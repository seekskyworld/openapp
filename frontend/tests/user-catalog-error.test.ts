import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import UserDashboard from '../src/features/instances/UserDashboard.tsx';
import { installBrowserEnvironment, waitFor } from './react-test-harness.ts';

test('unsupported app contract explains adapter configuration while retaining existing instances', async () => {
  const browser = installBrowserEnvironment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/apps') return new Response(JSON.stringify({ error: 'runtime_image_contract_unsupported' }), { status: 501 });
    if (path === '/api/entry/manifest') return new Response(JSON.stringify({ error: 'app_auth_handoff_not_registered' }), { status: 409 });
    assert.equal(path, '/api/containers');
    return new Response(JSON.stringify({ containers: [{ id: 'existing-instance', appId: 'sample-app', status: 'stopped', stopReason: 'manual_user', createdAt: '2026-09-16T00:00:00Z', updatedAt: '2026-09-16T00:00:00Z' }] }));
  };
  const root = createRoot(browser.container);
  try {
    await act(async () => root.render(createElement(UserDashboard)));
    await waitFor(() => assert.match(browser.container.textContent ?? '', /应用适配器（Adapter）/u));
    assert.match(browser.container.textContent ?? '', /existing-instance/u);
    assert.doesNotMatch(browser.container.textContent ?? '', /internal_error/u);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});
