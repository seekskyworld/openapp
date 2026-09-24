/** 用独立 Git 仓库验证发布门禁，不修改调用者的工作区或历史。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceProvenance } from './source-provenance.mjs';

test('official provenance rejects dirty sources and records clean revisions without host paths', t => {
  const root = mkdtempSync(join(tmpdir(), 'openapp-provenance-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.throws(() => sourceProvenance(root, { official: true }), /own Git checkout/);
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  git('init');
  writeFileSync(join(root, 'source.txt'), 'original');
  git('add', 'source.txt');
  git('-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '-m', 'test fixture');
  const clean = sourceProvenance(root, { official: true });
  assert.match(clean.revision, /^[a-f0-9]{40}$/);
  assert.equal(clean.dirty, false);
  assert.ok(!JSON.stringify(clean).includes(root));
  writeFileSync(join(root, 'source.txt'), 'changed');
  assert.throws(() => sourceProvenance(root, { official: true }), /clean component/);
  assert.notEqual(sourceProvenance(root).sourceDigest, clean.sourceDigest);
  writeFileSync(join(root, 'source.txt'), 'original');
  writeFileSync(join(root, 'untracked.txt'), 'new');
  assert.throws(() => sourceProvenance(root, { official: true }), /clean component/);
});
