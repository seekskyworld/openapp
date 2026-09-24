#!/usr/bin/env node

/**
 * 校验 Adapter 的静态资源边界。
 *
 * 适配器代码和品牌文件必须一起发布；Core 只把 `assets/` 复制到以
 * Adapter ID 命名的公共目录。这里不执行适配器代码，而是检查已编译产物
 * 中声明的 `/adapter-assets/<id>/...` 引用确实能在 assets/ 中找到，避免
 * 构建成功但登录页 Logo 在部署后 404。
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TEXT_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs"]);
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function usage() {
  return "usage: validate-adapter-assets.mjs --adapter-root <path> --adapter-id <id>";
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) throw new Error(usage());
  return argv[index + 1];
}

function normalizedAdapterId(value) {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(id)) throw new Error("adapter id is invalid");
  return id;
}

function safeRelativePath(value) {
  const normalized = value.split(sep).join("/");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !SAFE_SEGMENT.test(part))) {
    throw new Error(`adapter asset path is unsafe: ${value}`);
  }
  return normalized;
}

async function walkFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`adapter asset symlink is not allowed: ${path}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`adapter asset special file is not allowed: ${path}`);
  }
  return files;
}

async function existingFiles(root) {
  try {
    return new Map((await walkFiles(root)).map((path) => [safeRelativePath(relative(root, path)), path]));
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}

function isTestOrMetadata(relativePath) {
  return /(?:^|\.)test\.[^.]+$/u.test(relativePath)
    || /(?:^|\.)spec\.[^.]+$/u.test(relativePath)
    || relativePath.endsWith(".d.ts")
    || relativePath.endsWith(".map");
}

async function referencedAssets(distRoot, adapterId) {
  const references = new Set();
  const files = await existingFiles(distRoot);
  const referencePattern = new RegExp(
    `/adapter-assets/([a-z0-9][a-z0-9._-]{0,63})/([A-Za-z0-9._/-]+)`,
    "gu",
  );
  for (const [relativePath, absolutePath] of files) {
    if (!TEXT_EXTENSIONS.has(extname(relativePath))) continue;
    // 测试夹具可能故意引用不存在的资源；它们不会进入生产 dist，不能
    // 污染生产资产合同的校验结果。
    if (isTestOrMetadata(relativePath)) continue;
    const source = await readFile(absolutePath, "utf8");
    for (const match of source.matchAll(referencePattern)) {
      const namespace = match[1].toLowerCase();
      if (namespace !== adapterId) {
        throw new Error(`adapter asset namespace does not match adapter id: ${namespace}`);
      }
      const assetPath = safeRelativePath(match[2].replace(/\/+$/u, ""));
      references.add(assetPath);
    }
  }
  return references;
}

export async function validateAdapterAssets(adapterRootInput, adapterIdInput) {
  const adapterRoot = resolve(adapterRootInput);
  const adapterId = normalizedAdapterId(adapterIdInput);
  const assetRoot = join(adapterRoot, "assets");
  const distRoot = join(adapterRoot, "dist");
  for (const [label, path] of [["Adapter", adapterRoot], ["assets", assetRoot], ["dist", distRoot]]) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`${label} directory must be a regular directory: ${path}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT" && label !== "assets") throw error;
      if (error?.code === "ENOENT") continue;
      throw error;
    }
  }
  const files = await existingFiles(assetRoot);
  const references = await referencedAssets(distRoot, adapterId);
  const missing = [...references].filter((path) => !files.has(path));
  if (missing.length > 0) {
    throw new Error(`adapter asset references are missing from assets/: ${missing.join(", ")}`);
  }
  return { assets: [...files.keys()].sort(), references: [...references].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await validateAdapterAssets(option(process.argv.slice(2), "--adapter-root"), option(process.argv.slice(2), "--adapter-id"));
    process.stdout.write(`Adapter assets valid (${result.assets.length} files, ${result.references.length} referenced)\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
