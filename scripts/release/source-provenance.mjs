/** 发布来源只记录提交和内容摘要，不把开发机绝对路径或远端凭据写入制品。 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export function sourceProvenance(directory, { official = false } = {}) {
  const git = args => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  let revision;
  let dirty;
  try {
    if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(directory)) throw Error('not a repository root');
    revision = git(['rev-parse', 'HEAD']).trim();
    dirty = Boolean(git(['status', '--porcelain', '--untracked-files=all']).trim());
  } catch {
    if (official) throw Error('official release requires each component to have its own Git checkout');
    return { revision: null, dirty: true, sourceDigest: null };
  }
  if (official && dirty) throw Error('official release requires clean component worktrees');
  const names = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const hash = createHash('sha256');
  for (const name of [...new Set(names)].sort()) {
    hash.update(name).update('\0');
    try {
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) throw Error('release source must be regular files');
      hash.update(readFileSync(path));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('<deleted>');
    }
    hash.update('\0');
  }
  return { revision, dirty, sourceDigest: hash.digest('hex') };
}
