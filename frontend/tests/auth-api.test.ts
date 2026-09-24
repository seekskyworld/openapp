import assert from 'node:assert/strict';
import test from 'node:test';
import { authApi } from '../src/auth-api.ts';

test('generic email-code API keeps challenge metadata opaque', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    requiresOrganization: true,
    requiresPlan: false,
    isNewUser: true,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    assert.deepEqual(await authApi.sendExternalEmailCode('provider-a', 'user@example.test'), {
      providerData: { requiresOrganization: true, requiresPlan: false },
      isNewUser: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generic external login sends Provider data as one opaque object', async () => {
  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      user: { id: 'user-1', email: 'user@example.test', role: 'user' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await authApi.externalLogin('provider-a', 'user@example.test', '123456', {
      organizationKey: 'opaque-value',
      organization: 'acme',
    });
    assert.deepEqual(body, {
      email: 'user@example.test',
      code: '123456',
      providerData: {
        organizationKey: 'opaque-value',
        organization: 'acme',
      },
    });
    assert.equal('organizationKey' in body!, false);
    assert.equal('planKey' in body!, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
