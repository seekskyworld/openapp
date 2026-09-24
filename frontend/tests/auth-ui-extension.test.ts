import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAuthUiExtension } from '../src/features/auth/auth-ui';

test('modern UI loads without calling legacy factories and exposes views only', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ schemaVersion: 1, providers: { sso: '/adapter-assets/sample/ui.mjs' } });
  const View = () => null;
  try {
    const extension = await loadAuthUiExtension('sso', async () => ({ apiVersion: 1,
      createAuthUi: () => ({ views: { control: View, workspace: View }, legacyEntryManifest: {} }),
      createAuthCompatibility: () => { throw Error('legacy factory must not run'); },
    }));
    assert.deepEqual(extension, { views: { control: View, workspace: View } });
    assert.deepEqual(await loadAuthUiExtension('unknown', async () => { throw Error('not selected'); }), {});
    globalThis.fetch = async () => Response.json({ error: 'not_found' }, { status: 404 });
    assert.deepEqual(await loadAuthUiExtension('sso'), {});
  } finally { globalThis.fetch = original; }
});

test('UI loader rejects external paths, unsupported versions and malformed catalogs', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ schemaVersion: 1, providers: { sso: 'https://example.test/ui.mjs' } });
    await assert.rejects(loadAuthUiExtension('sso'), /path_invalid/);
    globalThis.fetch = async () => Response.json({ schemaVersion: 1, providers: { sso: '/adapter-assets/sample/ui.mjs' } });
    await assert.rejects(loadAuthUiExtension('sso', async () => ({ apiVersion: 2 })), /incompatible/);
    globalThis.fetch = async () => Response.json({ schemaVersion: 1, providers: [] });
    await assert.rejects(loadAuthUiExtension('sso'), /catalog_invalid/);
  } finally { globalThis.fetch = original; }
});
