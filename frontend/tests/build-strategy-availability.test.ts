import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import AppsPanel from '../src/features/admin/AppsPanel.tsx';
import { installBrowserEnvironment, waitFor } from './react-test-harness.ts';

for (const reason of ['adapter_not_loaded', 'adapter_version_mismatch', 'control_plane_only']) {
  test(`App build controls are disabled for ${reason}`, async () => {
    const browser = installBrowserEnvironment();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = String(input);
      const data = path.includes('/build-strategies') ? { strategies: [{ id: 'sample', revision: 1, name: 'Sample', description: 'Stored strategy', status: 'active', executable: false, unavailableReason: reason, packageRequirements: [{ key: 'bundle', required: true, acceptedExtensions: ['.zip'] }] }] }
        : path.includes('/build-packages') ? { packages: [] }
        : path.includes('/versions') ? { versions: [] }
        : { apps: ['sample'], items: [{ id: 'sample', name: 'Sample', description: '', status: 'active' }] };
      return new Response(JSON.stringify(data));
    };
    const root = createRoot(browser.container);
    try {
      await act(async () => root.render(createElement(AppsPanel)));
      await waitFor(() => {
        const button = [...browser.container.querySelectorAll('button')].find(item => item.textContent?.includes('构建并测试候选镜像'));
        assert.equal(button, undefined);
        assert.equal(browser.container.querySelector<HTMLInputElement>('input[type=file]'), null);
        assert.match(browser.container.querySelector('[role=status]')?.textContent ?? '', reason === 'control_plane_only' ? /仅控制面/ : reason === 'adapter_version_mismatch' ? /版本不匹配/ : /Adapter 未加载/);
      });
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      browser.restore();
    }
  });
}

test('App build form shows only its declared strategy and arbitrary package slots', async () => {
  const browser = installBrowserEnvironment();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = String(input);
    const strategy = (id: string, appIds: string[], key: string) => ({ id, appIds, revision: 1, name: id, status: 'active', executable: true, packageRequirements: [{ key, required: true, acceptedExtensions: ['.zip'] }] });
    const data = path.includes('/build-strategies') ? { strategies: [strategy('other-strategy', ['other'], 'server'), strategy('sample-strategy', ['sample'], 'model')] }
      : path.includes('/build-packages') ? { packages: [] }
      : path.includes('/versions') ? { versions: [] }
      : { apps: ['sample'], items: [{ id: 'sample', name: 'Sample', description: '', status: 'active', canImportImage: true }] };
    return new Response(JSON.stringify(data));
  };
  const root = createRoot(browser.container);
  try {
    await act(async () => root.render(createElement(AppsPanel)));
    await waitFor(() => {
      const options = [...browser.container.querySelectorAll('option')].map(item => item.textContent);
      assert.ok(options.includes('sample-strategy'));
      assert.ok(!options.includes('other-strategy'));
      assert.ok(browser.container.querySelector('input[aria-label="上传 model 构建包"]'));
      assert.equal(browser.container.querySelector('input[aria-label="上传 server 构建包"]'), null);
      assert.ok(browser.container.textContent?.includes('校验并导入镜像'));
    });
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    browser.restore();
  }
});
