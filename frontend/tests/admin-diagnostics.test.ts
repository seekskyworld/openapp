import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import OperationsPanel from '../src/features/admin/OperationsPanel.tsx';
import { installBrowserEnvironment, waitFor } from './react-test-harness.ts';

for (const scenario of [
  { name: 'generic provider', status: { provider: { providerId: 'docker', available: true, version: '29.4.0' } }, expected: 'docker 29.4.0', css: 'ok' },
  { name: 'unavailable provider overrides old status', status: { provider: { providerId: 'docker', available: false }, runtime: { runtime: 'docker', available: true } }, expected: '不可用', css: 'warn' },
  { name: 'older runtime response', status: { runtime: { runtime: 'docker', available: true, version: '28.0' } }, expected: 'docker 28.0', css: 'ok' },
]) {
  test(`diagnostics displays ${scenario.name}`, async () => {
    const browser = installBrowserEnvironment();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = String(input);
      const payload = path === '/api/admin/config'
        ? { config: { authProviderConfigured: true, databaseConfigured: true, adminCliTokenConfigured: true, ...scenario.status } }
        : path.startsWith('/api/admin/operations') ? { operations: [] }
        : path.startsWith('/api/admin/audit') ? { events: [] }
        : { rollouts: [] };
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    };
    const root = createRoot(browser.container);
    try {
      await act(async () => root.render(createElement(OperationsPanel)));
      await waitFor(() => {
        const row = [...browser.container.querySelectorAll('.diagnostic-grid > span')].find((item) => item.textContent?.startsWith('运行时'));
        assert.equal(row?.querySelector('b')?.textContent, scenario.expected);
        assert.equal(row?.querySelector('b')?.className, scenario.css);
      });
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      browser.restore();
    }
  });
}
