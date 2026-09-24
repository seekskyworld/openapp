import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../src/api.ts';
import { formatAuthError, resolveAuthLocale } from '../src/auth-i18n.ts';

test('auth locale uses the first supported browser language and otherwise falls back to English', () => {
  assert.equal(resolveAuthLocale({ languages: ['fr-FR', 'zh-Hans-CN'], language: 'fr-FR' }), 'zh-CN');
  assert.equal(resolveAuthLocale({ languages: ['en-GB'], language: 'en-GB' }), 'en');
  assert.equal(resolveAuthLocale({ languages: ['fr-FR'], language: 'fr-FR' }), 'en');
  assert.equal(resolveAuthLocale({ languages: [], language: '' }), 'en');
});

test('auth errors default to English and can be rendered in Chinese', () => {
  const reason = new ApiError(400, 'verification_code_invalid');
  assert.equal(formatAuthError(reason, 'fallback'), 'The verification code is incorrect or has expired.');
  assert.equal(formatAuthError(reason, 'fallback', 'zh-CN'), '验证码错误或已过期。');

});

test('manifest error catalog supplies safe App-specific auth diagnostics', () => {
  const reason = new ApiError(409, 'app_specific_unavailable');
  const catalog = {
    en: { app_specific_unavailable: 'The Story service is unavailable.' },
    'zh-CN': { app_specific_unavailable: 'Story 服务暂不可用。' },
  } as const;
  assert.equal(formatAuthError(reason, 'fallback', 'en', false, undefined, catalog), 'The Story service is unavailable.');
  assert.equal(formatAuthError(reason, 'fallback', 'zh-CN', false, undefined, catalog), 'Story 服务暂不可用。');
  assert.equal(formatAuthError(new ApiError(409, 'unknown'), 'fallback', 'en', false, undefined, catalog), 'fallback');
});
