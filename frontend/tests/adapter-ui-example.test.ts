/** 挂载文档附带的真实示例，防止教程只在伪代码中成立。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { authUiHost, type AuthUiModule } from '../src/features/auth/auth-ui';
import { installBrowserEnvironment, buttonWithText } from './react-test-harness';
const module: AuthUiModule = await import(new URL('../../examples/email-code-ui/assets/auth-ui.mjs', import.meta.url).href);

function fixture(mode: 'control' | 'workspace') {
  const browser = installBrowserEnvironment();
  const root = createRoot(browser.container);
  const View = module.createAuthUi!(authUiHost).views![mode];
  const authenticated: string[] = [];
  const render = () => React.act(async () => root.render(React.createElement(View, {
    locale: 'en', onLogin: user => authenticated.push(user.email),
  })));
  const click = (label: string) => React.act(async () => buttonWithText(browser.container, label).click());
  const input = (label: string) => browser.container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  const change = (label: string, value: string) => React.act(async () => {
    const element = input(label);
    assert.ok(element, `missing input: ${label}`);
    element.focus();
    Object.getOwnPropertyDescriptor(browser.window.HTMLInputElement.prototype, 'value')!.set!.call(element, value);
    const event = new browser.window.Event('propertychange', { bubbles: true });
    Object.defineProperty(event, 'propertyName', { value: 'value' });
    element.dispatchEvent(event);
    element.dispatchEvent(new browser.window.Event('input', { bubbles: true }));
  });
  const submit = () => React.act(async () => {
    browser.container.querySelector('form')!.dispatchEvent(new browser.window.Event('submit', { bubbles: true, cancelable: true }));
  });
  const close = async () => { await React.act(async () => root.unmount()); browser.restore(); };
  return { browser, authenticated, render, click, input, change, submit, close };
}

for (const mode of ['control', 'workspace'] as const) {
  test(`documented ${mode} UI handles challenge failure, existing users and registration metadata`, async () => {
    const ui = fixture(mode);
    const previous = globalThis.fetch;
    let failSend = true;
    const submissions: unknown[] = [];
    globalThis.fetch = async (path, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(path).endsWith('/email-codes')) {
        assert.equal(String(path), '/api/auth/external/sample-auth/email-codes');
        if (failSend) return Response.json({ error: 'upstream_secret_detail' }, { status: 429 });
        return Response.json({ ok: true, isNewUser: true, providerData: { requiresDisplayName: body.email.startsWith('new') } });
      }
      assert.equal(String(path), '/api/auth/external/sample-auth/login');
      submissions.push(body);
      if (body.code === 'bad') return Response.json({ error: 'verification_code_invalid' }, { status: 401 });
      return Response.json({ user: { id: 'sample-user', email: body.email, role: 'user' } });
    };
    try {
      await ui.render();
      if (mode === 'control') { assert.equal(ui.input('Email'), null); await ui.click('Sign in to Sample App'); }
      assert.equal(ui.input('Verification code'), null);
      await ui.change('Email', 'existing@example.test');
      await ui.submit();
      assert.ok(ui.input('Email'));
      assert.equal(ui.input('Verification code'), null);
      assert.match(ui.browser.container.textContent!, /Request failed/);
      assert.doesNotMatch(ui.browser.container.textContent!, /upstream_secret_detail/);
      failSend = false;
      await ui.submit();
      assert.equal(ui.input('Email'), null);
      assert.equal(ui.input('Display name'), null, 'isNewUser alone must not add registration fields');
      await ui.change('Verification code', 'bad');
      await ui.submit();
      assert.match(ui.browser.container.textContent!, /Invalid verification code/);
      await ui.change('Verification code', 'A-12');
      await ui.submit();
      assert.deepEqual(submissions[1], { email: 'existing@example.test', code: 'A-12', providerData: {} });
      assert.deepEqual(ui.authenticated, ['existing@example.test']);
      await ui.click('Change email');
      await ui.change('Email', 'new@example.test');
      await ui.submit();
      assert.ok(ui.input('Display name'));
      await ui.change('Verification code', 'B-34');
      await ui.change('Display name', 'Example Member');
      await ui.submit();
      assert.deepEqual(submissions[2], { email: 'new@example.test', code: 'B-34', providerData: { displayName: 'Example Member' } });
    } finally { await ui.close(); globalThis.fetch = previous; }
  });
}

test('documented UI blocks duplicate requests and ignores stale challenges after changing email', async () => {
  const ui = fixture('workspace');
  const previous = globalThis.fetch;
  let count = 0;
  let release: (response: Response) => void = () => { throw Error('no pending response'); };
  globalThis.fetch = async () => {
    count++;
    if (count === 2) return new Promise<Response>(resolve => { release = resolve; });
    return Response.json({ ok: true, providerData: { requiresDisplayName: false } });
  };
  try {
    await ui.render();
    await ui.change('Email', 'old@example.test');
    await ui.submit();
    await ui.change('Verification code', 'A-12');
    await ui.click('Resend code');
    await ui.submit();
    assert.equal(count, 2);
    await ui.click('Change email');
    await ui.change('Email', 'current@example.test');
    await ui.submit();
    await React.act(async () => release(Response.json({ ok: true, providerData: { requiresDisplayName: true } })));
    assert.equal(count, 3);
    assert.equal(ui.input('Display name'), null);
    assert.match(ui.browser.container.textContent!, /current@example.test/);
    assert.deepEqual(ui.authenticated, []);
  } finally { await ui.close(); globalThis.fetch = previous; }
});
