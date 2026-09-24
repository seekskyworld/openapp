/** 通用表单按合同收集字段；格式规则留给 Provider，不假设数字或注册地区。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { act, createElement, type ChangeEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { authApi, type ExternalAuthProvider } from '../src/auth-api.ts';
import { useEmailAuth, type EmailAuthFlow } from '../src/features/auth/useEmailAuth.ts';
import { installBrowserEnvironment } from './react-test-harness.ts';

test('email challenge preserves alphanumeric codes and opaque required field values', async () => {
  const browser = installBrowserEnvironment();
  const root = createRoot(browser.container);
  const originalSend = authApi.sendExternalEmailCode;
  const originalLogin = authApi.externalLogin;
  const provider: ExternalAuthProvider = { id: 'sample', label: 'Sample', iconUrl: '', challenge: 'email_code', fields: [
    { id: 'code', kind: 'verification_code', label: 'Code', maxLength: 8 },
    { id: 'organization', kind: 'organization_key', label: 'Organization', required: true },
  ] };
  let flow!: EmailAuthFlow;
  const submissions: unknown[][] = [];
  authApi.sendExternalEmailCode = async () => ({});
  authApi.externalLogin = async (...args) => { submissions.push(args); return { id: 'u1', email: args[1], role: 'user' }; };
  function Probe() {
    flow = useEmailAuth({ provider, locale: 'en', onLogin() {}, copy: {
      providerUnavailable: '', methodsLoadFailed: '', sessionRestoreFailed: '', sendCodeFailed: () => '', loginFailed: '',
    } });
    return null;
  }
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => flow.updateEmail({ currentTarget: { value: 'user@example.com' } } as ChangeEvent<HTMLInputElement>));
    await act(async () => flow.sendCode());
    await act(async () => flow.updateCode({ currentTarget: { value: 'Ab12-Z89' } } as ChangeEvent<HTMLInputElement>));
    assert.equal(flow.normalizedCode, 'Ab12-Z89');
    await act(async () => flow.authenticate());
    assert.equal(submissions.length, 0, 'required fields block submission');
    await act(async () => flow.updateProviderField('organization', 'mixedCase'));
    await act(async () => flow.authenticate());
    assert.deepEqual(submissions, [['sample', 'user@example.com', 'Ab12-Z89', { organization: 'mixedCase' }]]);
    await act(async () => flow.editEmail());
    assert.equal(flow.codeSent, false);
    assert.deepEqual(flow.providerFieldValues, {});
  } finally {
    await act(async () => root.unmount());
    authApi.sendExternalEmailCode = originalSend;
    authApi.externalLogin = originalLogin;
    browser.restore();
  }
});
