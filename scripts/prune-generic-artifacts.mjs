#!/usr/bin/env node

/**
 * 裁剪通用生产构建的生成目录。
 *
 * 通用运行镜像不应携带显式兼容入口、测试夹具或旧版前端 chunk；产品专属
 * 清理由外部检查策略声明。本工具只接受
 * 一个已解析的构建根，并且只在三个固定产物目录内操作；它不会访问数据库、
 * 发布包目录或用户运行时 Volume。
 */
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPATIBILITY_ARTIFACT_POLICY,
  GENERIC_FORBIDDEN_MARKER_PATTERN,
} from "./compatibility-manifest.mjs";

const TEXT_EXTENSIONS = new Set([".cjs", ".css", ".html", ".js", ".json", ".mjs", ".sh"]);
const FORBIDDEN_PRODUCT_MARKERS = GENERIC_FORBIDDEN_MARKER_PATTERN;

/**
 * 这些路径来自兼容清单，而不是模糊的字符串删除。新增 legacy 模块时必须
 * 先登记到隔离扫描器，再更新这里和对应的测试，保证 generic/legacy 发布面
 * 的差异可审计。
 */
export const GENERIC_ARTIFACT_POLICY = COMPATIBILITY_ARTIFACT_POLICY;

function usage() {
  return "usage: prune-generic-artifacts.mjs --root <build-root>";
}

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new Error(usage());
  }
  return argv[index + 1];
}

function assertSafeRoot(root) {
  // 删除操作只允许落在一个明确的临时/部署构建目录，拒绝根目录和当前目录。
  if (root === sep || root === dirname(root) || root === process.cwd()) {
    throw new Error(`generic artifact root is too broad: ${root}`);
  }
}

function absoluteWithin(root, relativePath) {
  const target = resolve(root, relativePath);
  const prefix = `${root}${sep}`;
  if (!target.startsWith(prefix)) throw new Error(`generic artifact path escapes root: ${relativePath}`);
  return target;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function removePath(root, relativePath, removed) {
  const target = absoluteWithin(root, relativePath);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`generic artifact sanitizer rejects symlink: ${relativePath}`);
  }
  await rm(target, { recursive: info.isDirectory(), force: true });
  removed.push(relativePath);
}

async function walkFiles(root, relativeDirectory, visitor) {
  const directory = absoluteWithin(root, relativeDirectory);
  if (!(await exists(directory))) return;
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`generic artifact sanitizer expects a directory: ${relativeDirectory}`);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = join(relativeDirectory, entry.name).split(sep).join("/");
    const child = absoluteWithin(root, childRelative);
    if (entry.isSymbolicLink()) {
      throw new Error(`generic artifact sanitizer rejects symlink: ${childRelative}`);
    }
    if (entry.isDirectory()) await walkFiles(root, childRelative, visitor);
    else if (entry.isFile()) await visitor(childRelative, child);
    else throw new Error(`generic artifact sanitizer rejects special file: ${childRelative}`);
  }
}

function pathMatchesLegacy(relativePath, paths) {
  return paths.some((candidate) => relativePath === candidate || relativePath.startsWith(`${candidate}/`));
}

function isGeneratedTestOrMetadata(relativePath) {
  return (
    relativePath.endsWith(".map") ||
    relativePath.endsWith(".d.ts") ||
    /(?:^|\.)test\.(?:cjs|js|mjs)$/u.test(relativePath)
  );
}

function stripJavaScriptComments(source) {
  let output = "";
  let state = "code";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") {
        output += character;
        state = "code";
      }
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (
        (state === "single" && character === "'") ||
        (state === "double" && character === '"') ||
        (state === "template" && character === "`")
      )
        state = "code";
      continue;
    }
    if (character === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 1;
      state = "block-comment";
      continue;
    }
    output += character;
    if (character === "'") state = "single";
    else if (character === '"') state = "double";
    else if (character === "`") state = "template";
  }
  return output;
}

function scanText(relativePath, source) {
  const candidate =
    extname(relativePath) === ".js" || extname(relativePath) === ".mjs" || extname(relativePath) === ".cjs"
      ? stripJavaScriptComments(source)
      : source;
  if (!FORBIDDEN_PRODUCT_MARKERS.test(candidate)) return undefined;
  const line = candidate.slice(0, candidate.search(FORBIDDEN_PRODUCT_MARKERS)).split("\n").length;
  return `${relativePath}:${line}`;
}

async function assertGenericArtifactTree(root, relativeDirectories) {
  const violations = [];
  for (const relativeDirectory of relativeDirectories) {
    await walkFiles(root, relativeDirectory, async (relativePath, absolutePath) => {
      if (!TEXT_EXTENSIONS.has(extname(relativePath)) || relativePath.endsWith(".map")) return;
      const source = await readFile(absolutePath, "utf8");
      const violation = scanText(relativePath, source);
      if (violation) violations.push(violation);
    });
  }
  if (violations.length > 0) {
    throw new Error(`generic artifact contains compatibility marker: ${violations.join(", ")}`);
  }
}

/**
 * 裁剪并校验 generic 构建目录。返回被移除的相对路径，重复调用是幂等的。
 */
export async function pruneGenericArtifacts(rootInput) {
  const root = resolve(rootInput);
  assertSafeRoot(root);
  const removed = [];
  const backendDist = "backend/dist";
  const runtimeDist = "backend/runtime/dist";
  const frontendWeb = "frontend/web";

  for (const relativePath of GENERIC_ARTIFACT_POLICY.backendLegacyPaths) {
    await removePath(root, `${backendDist}/${relativePath}`, removed);
  }
  await walkFiles(root, backendDist, async (relativePath) => {
    const nested = relativePath.slice(`${backendDist}/`.length);
    if (isGeneratedTestOrMetadata(nested)) await removePath(root, relativePath, removed);
  });
  for (const relativePath of GENERIC_ARTIFACT_POLICY.runtimeLegacyPaths) {
    await removePath(root, `${runtimeDist}/${relativePath}`, removed);
  }
  await walkFiles(root, runtimeDist, async (relativePath) => {
    const nested = relativePath.slice(`${runtimeDist}/`.length);
    if (isGeneratedTestOrMetadata(nested)) await removePath(root, relativePath, removed);
  });

  for (const asset of GENERIC_ARTIFACT_POLICY.frontendLegacyAssets) {
    await removePath(root, `${frontendWeb}/${asset}`, removed);
  }
  await walkFiles(root, frontendWeb, async (relativePath, absolutePath) => {
    const nested = relativePath.slice(`${frontendWeb}/`.length);
    const isLegacyChunk = GENERIC_ARTIFACT_POLICY.frontendLegacyChunkPrefixes.some(
      (prefix) => nested.startsWith(`assets/${prefix}`) && /\.(?:js|css|map)$/u.test(nested),
    );
    if (isLegacyChunk || nested.endsWith(".map")) {
      await removePath(root, relativePath, removed);
      return;
    }
    if (/\.(?:js|mjs|cjs|css|html)$/u.test(nested)) {
      // 删除 Vite 生成的 sourceMappingURL，避免 generic 包引用已裁剪的 map。
      const source = await readFile(absolutePath, "utf8");
      const cleaned = source.replace(/\n?\/\/#[ \t]*sourceMappingURL=[^\r\n]+/gu, "");
      if (cleaned !== source) await writeFile(absolutePath, cleaned);
    }
  });

  await assertGenericArtifactTree(root, [backendDist, runtimeDist, frontendWeb]);
  return removed;
}

// macOS 的临时目录可能经过 /var -> /private/var；比较真实路径才能识别 CLI 入口。
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const root = parseRoot(process.argv.slice(2));
    const removed = await pruneGenericArtifacts(root);
    process.stdout.write(JSON.stringify({ ok: true, removed }, null, 2) + "\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
