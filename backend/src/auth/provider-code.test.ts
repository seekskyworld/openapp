/** 验证认证和密码重置共同支持 Provider 自有验证码格式，仍拒绝空值与超长输入。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PortalAuth } from './portal-auth.js';
import { AccountCredentials } from './account-credentials.js';
import { AuthProviderRegistry } from './provider-registry.js';
import { MemoryPersistence } from '../persistence/memory.js';
import { createGenericPortalStores } from '../stores-core.js';
import type { AuthService } from './types.js';

test('provider owns code validation for both login and password changes', async () => {
  const persistence = new MemoryPersistence();
  const repository = createGenericPortalStores(persistence).identity;
  const codes: string[] = [];
  const provider: AuthService = {
    provider: 'sample',
    async sendEmailCode() {},
    async login(input) {
      codes.push(input.code);
      if (input.code !== 'Ab12-Z89') throw new Error('verification_code_invalid');
      return { identity: { provider: 'sample', subject: 'subject-1', email: input.email } };
    },
  };
  const registry = new AuthProviderRegistry([provider]);
  const auth = new PortalAuth('sample', provider, repository, {
    cookieName: 'session', secureCookies: false, sessionTtlHours: 1, adminCliToken: '',
  }, undefined, registry);
  for (const code of ['', 'x'.repeat(257)]) await assert.rejects(auth.loginExternal('sample', { email: 'user@example.com', code }), /verification_code_required/u);
  assert.deepEqual(codes, []);
  const result = await auth.loginExternal('sample', { email: 'user@example.com', code: 'Ab12-Z89' });
  assert.equal(result.user.email, 'user@example.com');
  const credentials = new AccountCredentials(repository, registry);
  await credentials.changeWithExternal(result.user, 'sample', 'Ab12-Z89', 'sample-test-password-123');
  assert.deepEqual(codes, ['Ab12-Z89', 'Ab12-Z89']);
  assert.ok(await repository.getLocalPasswordHash(result.user.id));
});
