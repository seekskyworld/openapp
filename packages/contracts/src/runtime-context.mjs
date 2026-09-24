#!/usr/bin/env node

/**
 * 校验 Adapter Runtime 的发布边界。
 *
 * Runtime Dockerfile 可以接收 App 制品作为构建参数，但其本地上下文只能由
 * `Dockerfile`、`profile.json` 和 profile 声明的 `contextFiles` 组成。这样导出器
 * 不会因为 Adapter 工作树里多了测试脚本、旧启动入口或符号链接而扩大镜像输入。
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._+\-]+$/u;
const MAX_CONTEXT_FILES = 128;
const METADATA_FILES = Object.freeze(["Dockerfile", "profile.json"]);

function usage() {
  return "usage: validate-adapter-runtime.mjs --adapter-root <path> [--runtime-root <path>] [--app-id <id>] [--require-app-id] [--print-context-files|--print-paths]";
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

function safeRelativePath(value, label = "runtime context file") {
  if (typeof value !== "string") throw new Error(`${label} path is invalid`);
  const normalized = value.trim();
  const parts = normalized.split("/");
  if (!normalized || normalized !== value || normalized.startsWith("/") || normalized.includes("\\")
    || normalized.includes("\0") || parts.some((part) => part === "." || part === ".." || !SAFE_SEGMENT.test(part))) {
    throw new Error(`${label} path is unsafe: ${value}`);
  }
  return normalized;
}

async function requireRegularDirectory(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a regular directory: ${path}`);
  }
}

async function requireRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`${label} symlink is not allowed: ${path}`);
  }
  if (!info.isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
  return info;
}

async function walkFiles(root, current = root) {
  const info = await lstat(current);
  if (info.isSymbolicLink()) throw new Error(`Adapter Runtime symlink is not allowed: ${current}`);
  if (!info.isDirectory()) throw new Error(`Adapter Runtime root contains a non-directory: ${current}`);
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const child = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Adapter Runtime symlink is not allowed: ${child}`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`Adapter Runtime special file is not allowed: ${child}`);
  }
  return files;
}

function parseProfile(source, profilePath, requireAppId = false) {
  let profile;
  try {
    profile = JSON.parse(source);
  } catch (error) {
    throw new Error(`Adapter Runtime profile is invalid: ${profilePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Adapter Runtime profile must be an object");
  }
  const runtimeContract = typeof profile.runtimeContract === "string"
    ? profile.runtimeContract.trim().toLowerCase()
    : typeof profile.contract === "string" ? profile.contract.trim().toLowerCase() : "";
  if (!SAFE_ID.test(runtimeContract)) throw new Error("Adapter Runtime profile runtimeContract is invalid");
  if (!Array.isArray(profile.contextFiles) || profile.contextFiles.length === 0 || profile.contextFiles.length > MAX_CONTEXT_FILES) {
    throw new Error("Adapter Runtime profile contextFiles must be a non-empty array");
  }
  const contextFiles = profile.contextFiles.map((value) => safeRelativePath(value));
  if (new Set(contextFiles).size !== contextFiles.length) {
    throw new Error("Adapter Runtime profile contextFiles contain duplicates");
  }
  if (!contextFiles.includes("start.sh")) {
    throw new Error("Adapter Runtime profile contextFiles must include start.sh");
  }
  if (contextFiles.some((value) => METADATA_FILES.includes(value))) {
    throw new Error("Adapter Runtime profile contextFiles cannot include Dockerfile or profile.json");
  }
  const appId = profile.appId === undefined ? undefined : normalizedId(profile.appId, "Adapter Runtime profile appId");
  if (requireAppId && appId === undefined) {
    throw new Error("Adapter Runtime profile appId is required");
  }
  return { profile, appId, runtimeContract, contextFiles };
}

function logicalDockerfileLines(source) {
  const logical = [];
  let pending = "";
  for (const rawLine of source.replace(/\r\n/gu, "\n").split("\n")) {
    const line = rawLine.replace(/[ \t]+$/u, "");
    const continued = /\\$/u.test(line);
    const part = continued ? line.slice(0, -1) : line;
    pending += part;
    if (!continued) {
      logical.push(pending);
      pending = "";
    }
  }
  if (pending) logical.push(pending);
  return logical;
}

function tokenizeInstruction(value) {
  if (value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (escaped || quote) return undefined;
  if (token) tokens.push(token);
  return tokens;
}

function extractDockerfileSources(source) {
  const references = [];
  for (const line of logicalDockerfileLines(source)) {
    const match = /^\s*(COPY|ADD)\s+(.+)$/iu.exec(line);
    if (!match || /^\s*#/u.test(line)) continue;
    const tokens = tokenizeInstruction(match[2]);
    if (!tokens || tokens.length < 2) throw new Error("Adapter Runtime Dockerfile has an invalid COPY/ADD instruction");
    let index = 0;
    let fromStage = false;
    while (index < tokens.length - 1 && tokens[index].startsWith("--")) {
      if (tokens[index].toLowerCase().startsWith("--from=")) fromStage = true;
      index += 1;
    }
    if (index >= tokens.length - 1) throw new Error("Adapter Runtime Dockerfile has no COPY/ADD source");
    if (fromStage) continue;
    const sources = tokens.slice(index, -1);
    for (const sourcePath of sources) {
      // Build arguments point at the staged App packages, not files in the
      // Adapter Runtime directory. Their existence is checked by the build script.
      if (sourcePath.includes("$")) continue;
      if (sourcePath.includes("*") || sourcePath.includes("?") || sourcePath.includes("[")) {
        throw new Error(`Adapter Runtime Dockerfile source glob is not allowed: ${sourcePath}`);
      }
      references.push(safeRelativePath(sourcePath, "Adapter Runtime Dockerfile source"));
    }
  }
  return references;
}

function assertWithinRoot(root, relativePath) {
  const target = resolve(root, relativePath);
  const prefix = `${resolve(root)}${sep}`;
  if (!target.startsWith(prefix)) throw new Error(`Adapter Runtime path escapes root: ${relativePath}`);
  return target;
}

/**
 * 校验并返回可复制的 Runtime 文件清单。返回的绝对路径均已通过 lstat，
 * 调用方不应再对 Runtime 目录执行递归复制。
 */
export async function validateAdapterRuntime(options = {}) {
  const adapterRoot = resolve(options.adapterRoot ?? "");
  const runtimeRoot = resolve(options.runtimeRoot ?? join(adapterRoot, "runtime"));
  const expectedAppId = options.appId === undefined ? undefined : normalizedId(options.appId, "requested App id");
  const requireAppId = options.requireAppId === true;
  await requireRegularDirectory(runtimeRoot, "Adapter Runtime directory");

  const dockerfilePath = join(runtimeRoot, "Dockerfile");
  const profilePath = join(runtimeRoot, "profile.json");
  await requireRegularFile(dockerfilePath, "Adapter Runtime Dockerfile");
  await requireRegularFile(profilePath, "Adapter Runtime profile");
  const { profile, appId, runtimeContract, contextFiles } = parseProfile(
    await readFile(profilePath, "utf8"),
    profilePath,
    requireAppId,
  );
  if (expectedAppId !== undefined && appId !== undefined && appId !== expectedAppId) {
    throw new Error(`Adapter Runtime profile appId does not match requested App: ${appId}`);
  }

  const contextPaths = contextFiles.map((path) => {
    const absolute = assertWithinRoot(runtimeRoot, path);
    return { path, absolute };
  });
  for (const { path, absolute } of contextPaths) await requireRegularFile(absolute, `Adapter Runtime context file ${path}`);

  const registered = new Set([...METADATA_FILES, ...contextFiles]);
  const actualFiles = new Set((await walkFiles(runtimeRoot)).map((path) => relative(runtimeRoot, path).split(sep).join("/")));
  const unregistered = [...actualFiles].filter((path) => !registered.has(path)).sort();
  if (unregistered.length > 0) {
    throw new Error(`Adapter Runtime contains unregistered files: ${unregistered.join(", ")}`);
  }
  const missingMetadata = METADATA_FILES.filter((path) => !actualFiles.has(path));
  if (missingMetadata.length > 0) throw new Error(`Adapter Runtime metadata is missing: ${missingMetadata.join(", ")}`);

  const dockerfileSourcePaths = extractDockerfileSources(await readFile(dockerfilePath, "utf8"));
  for (const sourcePath of dockerfileSourcePaths) {
    if (!actualFiles.has(sourcePath)) {
      throw new Error(`Adapter Runtime Dockerfile source is not in the Runtime boundary: ${sourcePath}`);
    }
    if (!registered.has(sourcePath)) {
      throw new Error(`Adapter Runtime Dockerfile source is not declared in contextFiles: ${sourcePath}`);
    }
  }

  return Object.freeze({
    adapterRoot,
    runtimeRoot,
    dockerfile: dockerfilePath,
    profile: profilePath,
    appId,
    runtimeContract,
    contextFiles: Object.freeze(contextPaths.map(({ path }) => path)),
    contextPaths: Object.freeze(contextPaths.map(({ absolute }) => absolute)),
    dockerfileSources: Object.freeze([...dockerfileSourcePaths]),
  });
}

function parseArgs(argv) {
  return {
    adapterRoot: option(argv, "--adapter-root"),
    runtimeRoot: option(argv, "--runtime-root"),
    appId: option(argv, "--app-id"),
    requireAppId: argv.includes("--require-app-id"),
    printContextFiles: argv.includes("--print-context-files"),
    printPaths: argv.includes("--print-paths"),
  };
}

export async function runRuntimeValidationCli() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.adapterRoot && !args.runtimeRoot) throw new Error(usage());
    const result = await validateAdapterRuntime(args);
    if (args.printContextFiles) {
      for (const path of result.contextPaths) process.stdout.write(`${path}\n`);
    } else if (args.printPaths) {
      process.stdout.write(`${result.dockerfile}\n${result.profile}\n`);
      for (const path of result.contextPaths) process.stdout.write(`${path}\n`);
    } else {
      process.stdout.write(`Adapter Runtime valid (${result.contextFiles.length} context files, ${result.runtimeContract})\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

