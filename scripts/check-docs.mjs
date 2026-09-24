#!/usr/bin/env node
/**
 * 检查公开 Markdown 中的本地链接；文档失效时在发布前失败，避免新用户按错误路径安装。
 */
import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

function destinationFromMarkdown(match) {
  const raw = match.trim().replace(/^<|>$/gu, "");
  return raw.split(/\s+/u, 1)[0] ?? "";
}

function isExternal(destination) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(destination);
}

function headingAnchor(text) {
  return text
    .trim()
    .toLocaleLowerCase()
    .replace(/<[^>]+>/gu, "")
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, "")
    .replace(/[\s_]+/gu, "-");
}

export async function findBrokenLinks(root, files) {
  const broken = [];
  for (const file of files) {
    const source = await readFile(resolve(root, file), "utf8");
    const pattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;
    for (const match of source.matchAll(pattern)) {
      const destination = destinationFromMarkdown(match[1] ?? "");
      if (!destination || isExternal(destination)) continue;
      const [pathPart, fragment] = destination.split("#", 2);
      const target = resolve(dirname(resolve(root, file)), decodeURIComponent(pathPart ?? ""));
      try {
        await access(target);
      } catch {
        broken.push(`${file}: ${destination}`);
        continue;
      }
      if (relative(root, target).startsWith("..")) broken.push(`${file}: escapes repository: ${destination}`);
      if (fragment && /\.md$/iu.test(target)) {
        const targetSource = await readFile(target, "utf8");
        const anchors = new Set(
          [...targetSource.matchAll(/^#{1,6}\s+(.+)$/gmu)].map((heading) => headingAnchor(heading[1] ?? "")),
        );
        if (!anchors.has(decodeURIComponent(fragment).toLocaleLowerCase()))
          broken.push(`${file}: missing heading anchor: ${destination}`);
      }
    }
  }
  return broken;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(process.argv[2] ?? ".");
  const { stdout } = await exec("git", ["ls-files", "*.md"], { cwd: root });
  const files = stdout.trim() ? stdout.trim().split("\n") : [];
  const broken = await findBrokenLinks(root, files);
  if (broken.length) {
    console.error(`Broken local Markdown links (${broken.length}):\n${broken.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Markdown links verified (${files.length} files)`);
  }
}
