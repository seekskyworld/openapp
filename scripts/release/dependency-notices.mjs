/** 为交付组件记录实际安装的依赖清单及许可证文本，不扫描本地运行数据。 */
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeDependencyNotices(root, output) {
  const target = join(output, 'third-party');
  await mkdir(target, { recursive: true });
  for (const component of ['backend', 'frontend']) {
    const directory = join(root, component);
    const bom = JSON.parse(execFileSync('npm', ['sbom', '--omit=dev', '--sbom-format=cyclonedx'], { cwd: directory, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }));
    // 时间与随机 UUID 不属于构建输入，删除它们以保持内容摘要可比较。
    delete bom.serialNumber;
    delete bom.metadata.timestamp;
    await writeFile(join(target, `${component}.cdx.json`), JSON.stringify(bom, null, 2) + '\n');
    const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
    const texts = [];
    for (const [path, metadata] of Object.entries(lock.packages)) {
      if (!path.startsWith('node_modules/') || metadata.dev || metadata.link) continue;
      const packageRoot = join(directory, path);
      let entries;
      try { entries = await readdir(packageRoot, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT' && metadata.optional) continue; throw error; }
      const packageMetadata = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
      const licenseFiles = entries.filter(e => e.isFile() && /^(licen[cs]e|copying|notice)([._-]|$)/i.test(e.name));
      const declared = packageMetadata.license ?? metadata.license
        ?? packageMetadata.licenses?.map(item => typeof item === 'string' ? item : item.type).join(', ');
      texts.push(`## ${path} ${metadata.version}\nDeclared license: ${typeof declared === 'object' ? JSON.stringify(declared) : declared ?? 'not declared'}\n`);
      for (const file of licenseFiles) texts.push(`### ${file.name}\n\n${await readFile(join(packageRoot, file.name), 'utf8')}\n`);
      if (!licenseFiles.length) {
        // 有些 npm 包把完整许可附在 README 中，不能仅按 LICENSE 文件名遗漏。
        let embeddedLicense;
        for (const file of entries.filter(e => e.isFile() && /^readme([._-]|$)/i.test(e.name))) {
          const source = await readFile(join(packageRoot, file.name), 'utf8');
          const start = source.search(/^#{1,6}\s+licen[cs]e\b/im);
          if (start >= 0) { embeddedLicense = `### ${file.name} license section\n\n${source.slice(start)}\n`; break; }
        }
        texts.push(embeddedLicense ?? 'No license text found at package root; review the package before redistribution.\n');
      }
    }
    await writeFile(join(target, `${component}-LICENSES.txt`), texts.join('\n'));
  }
}
