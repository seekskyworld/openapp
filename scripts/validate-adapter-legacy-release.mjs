#!/usr/bin/env node

/**
 * 校验 Adapter 持有的 legacy 发布面。
 *
 * legacy 文件是旧用户/数据库/Volume 的回滚输入，不能由 Core 工作树中的
 * 同名副本偷偷替代。本脚本只读取 Adapter 的清单和普通文件，拒绝路径穿越、
 * 符号链接、特殊文件、缺失输入以及未登记文件，并可按固定顺序输出绝对路径
 * 供 bundle exporter 使用。
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const LEGACY_FILE_KEYS = Object.freeze([
  "compose",
  "localCompose",
  "backendDockerfile",
  "deploy",
  "preflight",
  "composeSelector",
  "fingerprint",
  "compositionLock",
  "runtimeDockerfile",
  "runtimeStart",
  "runtimeRecovery",
  "buildRuntime",
  "verifyRuntime",
  "legacySeed",
  "migrationPlan",
  "exportBundle",
]);
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function usage() {
  return "usage: validate-adapter-legacy-release.mjs --adapter-root <path> [--release-root <path>] [--app-id <id>] [--adapter-id <id>] [--print-paths]";
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(usage());
  return value;
}

function normalizedId(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SAFE_ID.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\")) {
    throw new Error(`legacy release path is unsafe: ${String(value)}`);
  }
  const normalized = value.split(sep).join("/");
  if (normalized.startsWith("/") || normalized.split("/").some((part) => (
    part === "." || part === ".." || !SAFE_SEGMENT.test(part)
  ))) {
    throw new Error(`legacy release path is unsafe: ${value}`);
  }
  return normalized;
}

async function requireRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function walkFiles(root, current = root) {
  let info;
  try {
    info = await lstat(current);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`legacy release rejects symlink: ${current}`);
  if (!info.isDirectory()) throw new Error(`legacy release root must be a directory: ${current}`);
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const child = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`legacy release rejects symlink: ${child}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`legacy release rejects special file: ${child}`);
  }
  return files;
}

/**
 * 返回经过所有边界检查的 legacy 文件路径。调用方可以只消费这个结果，
 * 从而保证导出器不会在校验后再回退到 Core 的历史路径。
 */
export async function validateAdapterLegacyRelease(options = {}) {
  const adapterRoot = resolve(options.adapterRoot ?? "");
  const releaseRoot = resolve(options.releaseRoot ?? join(adapterRoot, "deployment", "legacy"));
  await requireRegularFile(join(releaseRoot, "manifest.json"), "legacy release manifest");
  await requireRegularFile(join(releaseRoot, "README.md"), "legacy release README");

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(releaseRoot, "manifest.json"), "utf8"));
  } catch (error) {
    throw new Error(`legacy release manifest is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("legacy release manifest must be an object");
  }
  if (manifest.schemaVersion !== 1) throw new Error("legacy release manifest schemaVersion must be 1");
  const appId = normalizedId(manifest.appId, "legacy release appId");
  const adapterId = normalizedId(manifest.adapterId, "legacy release adapterId");
  if (options.appId !== undefined && appId !== normalizedId(options.appId, "requested appId")) {
    throw new Error(`legacy release appId does not match requested app: ${appId}`);
  }
  if (options.adapterId !== undefined && adapterId !== normalizedId(options.adapterId, "requested adapterId")) {
    throw new Error(`legacy release adapterId does not match requested adapter: ${adapterId}`);
  }
  if (typeof manifest.version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,127}$/u.test(manifest.version.trim())) {
    throw new Error("legacy release manifest version is invalid");
  }

  const packagePath = join(adapterRoot, "package.json");
  await requireRegularFile(packagePath, "Adapter package manifest");
  const packageManifest = JSON.parse(await readFile(packagePath, "utf8"));
  if (typeof packageManifest.version !== "string" || packageManifest.version.trim() !== manifest.version.trim()) {
    throw new Error("legacy release version does not match Adapter package version");
  }

  const files = manifest.files;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("legacy release manifest files must be an object");
  }
  const keys = Object.keys(files).sort();
  const expectedKeys = [...LEGACY_FILE_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error(`legacy release manifest file keys must be exactly: ${LEGACY_FILE_KEYS.join(", ")}`);
  }

  const resolvedFiles = {};
  const registeredPaths = new Set(["manifest.json", "README.md"]);
  for (const key of LEGACY_FILE_KEYS) {
    const relativePath = safeRelativePath(files[key]);
    if (registeredPaths.has(relativePath)) throw new Error(`legacy release file is duplicated: ${relativePath}`);
    registeredPaths.add(relativePath);
    const absolutePath = join(releaseRoot, ...relativePath.split("/"));
    await requireRegularFile(absolutePath, `legacy release file ${key}`);
    resolvedFiles[key] = absolutePath;
  }

  const actualFiles = new Set((await walkFiles(releaseRoot)).map((path) => relative(releaseRoot, path).split(sep).join("/")));
  const unregistered = [...actualFiles].filter((path) => !registeredPaths.has(path)).sort();
  if (unregistered.length > 0) throw new Error(`legacy release contains unregistered files: ${unregistered.join(", ")}`);
  const missing = [...registeredPaths].filter((path) => !actualFiles.has(path));
  if (missing.length > 0) throw new Error(`legacy release manifest files are missing: ${missing.join(", ")}`);

  return {
    appId,
    adapterId,
    version: manifest.version.trim(),
    releaseRoot,
    files: Object.freeze(resolvedFiles),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    const result = await validateAdapterLegacyRelease({
      adapterRoot: option(argv, "--adapter-root"),
      releaseRoot: option(argv, "--release-root"),
      appId: option(argv, "--app-id"),
      adapterId: option(argv, "--adapter-id"),
    });
    if (argv.includes("--print-paths")) {
      for (const key of LEGACY_FILE_KEYS) process.stdout.write(`${result.files[key]}\n`);
    } else {
      process.stdout.write(`Adapter legacy release valid (${result.version})\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
