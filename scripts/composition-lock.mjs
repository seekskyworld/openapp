#!/usr/bin/env node

/**
 * 记录并校验一次可重现的 OpenApp 组合。清单只包含源码/制品摘要和合同
 * 元数据，不包含 .env、凭证、数据库或 Volume 内容；部署脚本在产生 Docker
 * 副作用前调用 verify，避免只替换一层导致 Core、Adapter 与 App 不匹配。
 */
import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const COMPOSITION_LOCK_FILE = ".openapp-composition-lock.json";
export const COMPOSITION_LOCK_SCHEMA_VERSION = 3;

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/u;
const SAFE_PLATFORM = /^linux\/(?:amd64|arm64)$/u;

export async function createCompositionLock(options = {}) {
  const root = resolve(options.root ?? ".");
  const appId = normalizedId(options.appId ?? process.env.OPENAPP_APP_ID ?? readEnvExample(root, "OPENAPP_APP_ID") ?? "openapp");
  const adapterId = normalizedId(options.adapterId ?? process.env.OPENAPP_ADAPTER_ID ?? readEnvExample(root, "OPENAPP_ADAPTER_ID") ?? appId);
  const releasePath = safeReleasePath(options.releasePath ?? process.env.OPENAPP_RELEASE_PATH ?? readEnvExample(root, "OPENAPP_RELEASE_PATH") ?? appId);
  const targetPlatform = normalizedPlatform(options.targetPlatform ?? process.env.TARGET_PLATFORM ?? readEnvExample(root, "TARGET_PLATFORM") ?? "linux/amd64");
  const runtimeImage = normalizedImage(options.runtimeImage
    ?? process.env.OPENAPP_RUNTIME_IMAGE
    ?? `${appId}-runtime:unresolved`);
  const releaseFiles = await releaseInventory(root, releasePath);
  const contractsPackage = await readJsonIfPresent(join(root, "packages/contracts/package.json"));
  const adapterPackage = await readJsonIfPresent(join(root, `adapters/${adapterId}/package.json`));
  const runtimeProfile = await readRuntimeProfile(root, adapterId, options.runtimeContract, options.runtimeProfile);
  const adapterManifest = await readAdapterManifestIdentity(
    root,
    adapterId,
    appId,
    adapterPackage,
    runtimeProfile.contract,
  );
  const sourceFingerprint = options.sourceFingerprint
    ?? (await readTextIfPresent(join(root, ".openapp-source-fingerprint")))
    ?? "";
  if (!/^[a-f0-9]{64}$/u.test(sourceFingerprint)) {
    throw new Error("composition lock requires a valid deployment source fingerprint");
  }

  const lock = {
    schemaVersion: COMPOSITION_LOCK_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    core: {
      revision: options.coreRevision ?? await gitRevision(options.coreRoot),
      digest: await digestPaths(root, [
        "backend/dist",
        "backend/runtime/dist",
        "backend/package.json",
        "backend/package-lock.json",
        "backend/runtime/package.json",
        "backend/runtime/package-lock.json",
        "backend/deployment",
      ]),
    },
    contracts: {
      version: stringOrUndefined(contractsPackage?.version) ?? "unknown",
      digest: await digestOptionalPath(root, "packages/contracts"),
    },
    adapter: {
      id: adapterId,
      manifest: adapterManifest,
      version: stringOrUndefined(adapterPackage?.version) ?? "unknown",
      revision: options.adapterRevision ?? await gitRevision(options.adapterSourceRoot),
      digest: await digestOptionalPath(root, `adapters/${adapterId}`),
    },
    app: {
      id: appId,
      releasePath,
      files: releaseFiles,
      revision: stringOrUndefined(options.appRevision ?? process.env.OPENAPP_APP_REVISION_ID),
      sourceRevision: stringOrUndefined(options.appSourceRevision ?? process.env.OPENAPP_APP_SOURCE_REVISION),
    },
    runtime: {
      image: runtimeImage,
      targetPlatform,
      contract: runtimeProfile.contract,
      profile: runtimeProfile.profile,
      digest: await digestRuntime(root),
    },
    sourceFingerprint,
  };
  const lockPath = join(root, COMPOSITION_LOCK_FILE);
  await mkdir(dirname(lockPath), { recursive: true });
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return lock;
}

export async function verifyCompositionLock(options = {}) {
  const root = resolve(options.root ?? ".");
  const lockPath = join(root, COMPOSITION_LOCK_FILE);
  let lock;
  try {
    lock = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (options.allowLegacy || process.env.OPENAPP_ALLOW_LEGACY_COMPOSITION_LOCK === "true") {
      return { skipped: true, reason: "composition_lock_missing" };
    }
    throw new Error(`composition lock is missing or unreadable: ${lockPath}`);
  }
  validateLockShape(lock);
  const expected = await createExpectedSnapshot(root, options);
  const checks = [
    ["schemaVersion", lock.schemaVersion, COMPOSITION_LOCK_SCHEMA_VERSION],
    ["core.digest", lock.core.digest, expected.core.digest],
    ["contracts.version", lock.contracts.version, expected.contracts.version],
    ["contracts.digest", lock.contracts.digest, expected.contracts.digest],
    ["adapter.id", lock.adapter.id, expected.adapter.id],
    ["adapter.manifest", stableJson(lock.adapter.manifest), stableJson(expected.adapter.manifest)],
    ["adapter.version", lock.adapter.version, expected.adapter.version],
    ["adapter.digest", lock.adapter.digest, expected.adapter.digest],
    ["app.id", lock.app.id, expected.app.id],
    ["app.releasePath", lock.app.releasePath, expected.app.releasePath],
    ["app.files", stableJson(lock.app.files), stableJson(expected.app.files)],
    ["runtime.image", lock.runtime.image, expected.runtime.image],
    ["runtime.targetPlatform", lock.runtime.targetPlatform, expected.runtime.targetPlatform],
    ["runtime.contract", lock.runtime.contract, expected.runtime.contract],
    ["runtime.profile", stableJson(lock.runtime.profile), stableJson(expected.runtime.profile)],
    ["runtime.digest", lock.runtime.digest, expected.runtime.digest],
    ["sourceFingerprint", lock.sourceFingerprint, expected.sourceFingerprint],
  ];
  for (const [field, actual, wanted] of checks) {
    if (actual !== wanted) throw new Error(`composition lock mismatch at ${field}`);
  }
  return { skipped: false, lock };
}

async function createExpectedSnapshot(root, options) {
  const appId = normalizedId(options.appId ?? process.env.OPENAPP_APP_ID ?? readEnvExample(root, "OPENAPP_APP_ID") ?? "openapp");
  const adapterId = normalizedId(options.adapterId ?? process.env.OPENAPP_ADAPTER_ID ?? readEnvExample(root, "OPENAPP_ADAPTER_ID") ?? appId);
  const releasePath = safeReleasePath(options.releasePath ?? process.env.OPENAPP_RELEASE_PATH ?? readEnvExample(root, "OPENAPP_RELEASE_PATH") ?? appId);
  const targetPlatform = normalizedPlatform(options.targetPlatform ?? process.env.TARGET_PLATFORM ?? readEnvExample(root, "TARGET_PLATFORM") ?? "linux/amd64");
  const releaseFiles = await releaseInventory(root, releasePath);
  const contractsPackage = await readJsonIfPresent(join(root, "packages/contracts/package.json"));
  const adapterPackage = await readJsonIfPresent(join(root, `adapters/${adapterId}/package.json`));
  const runtimeProfile = await readRuntimeProfile(root, adapterId, options.runtimeContract, options.runtimeProfile);
  const adapterManifest = await readAdapterManifestIdentity(
    root,
    adapterId,
    appId,
    adapterPackage,
    runtimeProfile.contract,
  );
  const runtimeImage = normalizedImage(options.runtimeImage
    ?? process.env.OPENAPP_RUNTIME_IMAGE
    ?? `${appId}-runtime:unresolved`);
  const sourceFingerprint = options.sourceFingerprint
    ?? (await readTextIfPresent(join(root, ".openapp-source-fingerprint")))
    ?? "";
  return {
    core: {
      digest: await digestPaths(root, [
        "backend/dist",
        "backend/runtime/dist",
        "backend/package.json",
        "backend/package-lock.json",
        "backend/runtime/package.json",
        "backend/runtime/package-lock.json",
        "backend/deployment",
      ]),
    },
    contracts: {
      version: stringOrUndefined(contractsPackage?.version) ?? "unknown",
      digest: await digestOptionalPath(root, "packages/contracts"),
    },
    adapter: {
      id: adapterId,
      manifest: adapterManifest,
      version: stringOrUndefined(adapterPackage?.version) ?? "unknown",
      digest: await digestOptionalPath(root, `adapters/${adapterId}`),
    },
    app: {
      id: appId,
      releasePath,
      files: releaseFiles,
    },
    runtime: {
      image: runtimeImage,
      targetPlatform,
      contract: runtimeProfile.contract,
      profile: runtimeProfile.profile,
      digest: await digestRuntime(root),
    },
    sourceFingerprint,
  };
}

/** 只锁定显式交付目录中的文件，不推断业务包数量、格式或目录名称。 */
async function releaseInventory(root, releasePath) {
  const base = join(root, releasePath);
  const info = await lstat(base);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("release directory must be a real directory");
  const files = [];
  await collectFiles(base, base, files);
  return Promise.all(files.sort((a, b) => a.path.localeCompare(b.path, "en")).map(async (file) => {
    const bytes = await readFile(file.absolute);
    return { file: file.path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }));
}

async function readAdapterManifestIdentity(root, adapterId, appId, adapterPackage, runtimeContract) {
  const manifestPath = join(root, `adapters/${adapterId}/manifest.json`);
  let info;
  try {
    info = await lstat(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`composition lock requires Adapter manifest identity: ${manifestPath}`);
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`composition lock rejects non-regular Adapter manifest identity: ${manifestPath}`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Adapter manifest identity is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Adapter manifest identity must be an object");
  }
  if (value.apiVersion !== "v2") {
    throw new Error(`Adapter manifest identity API version is unsupported: ${value.apiVersion}`);
  }
  const manifestId = normalizedId(value.id);
  if (manifestId !== appId) throw new Error(`Adapter manifest identity id does not match App: ${manifestId}`);
  if (manifestId !== adapterId) throw new Error(`Adapter manifest identity id does not match Adapter slot: ${manifestId}`);
  const manifestVersion = stringOrUndefined(value.version);
  if (!manifestVersion) throw new Error("Adapter manifest identity version is missing");
  const packageVersion = stringOrUndefined(adapterPackage?.version);
  if (!packageVersion || packageVersion !== manifestVersion) {
    throw new Error("Adapter manifest identity version does not match package version");
  }
  const manifestRuntimeContract = normalizedId(value.runtimeContract);
  if (manifestRuntimeContract !== runtimeContract) {
    throw new Error("Adapter manifest identity runtime contract does not match Runtime profile");
  }
  return {
    apiVersion: "v2",
    id: manifestId,
    version: manifestVersion,
    runtimeContract: manifestRuntimeContract,
  };
}

async function readRuntimeProfile(root, adapterId, explicitContract, explicitProfile) {
  const profilePath = join(root, `runtime/profile.json`);
  const adapterProfilePath = join(root, `adapters/${adapterId}/runtime/profile.json`);
  const rootParsed = await readJsonIfPresent(profilePath);
  const adapterParsed = await readJsonIfPresent(adapterProfilePath);
  const parsed = explicitProfile ?? rootParsed ?? adapterParsed ?? {};
  const requiresAdapterIdentity = adapterParsed !== undefined;
  const identitySources = [
    ["Runtime profile", rootParsed],
    ["Adapter Runtime profile", adapterParsed],
    ["explicit Runtime profile", explicitProfile],
  ];
  for (const [label, candidate] of identitySources) {
    if (candidate === undefined) continue;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${label} must be an object`);
    }
    if (candidate.appId === undefined) {
      if (label === "Adapter Runtime profile" || (requiresAdapterIdentity && label !== "explicit Runtime profile")) {
        throw new Error(`composition lock requires ${label} appId`);
      }
      continue;
    }
    const profileAppId = normalizedId(candidate.appId);
    if (profileAppId !== adapterId) {
      throw new Error(`${label} appId does not match Adapter slot: ${profileAppId}`);
    }
  }
  const contract = stringOrUndefined(explicitContract)
    ?? stringOrUndefined(parsed.runtimeContract)
    ?? stringOrUndefined(parsed.contract)
    ?? process.env.OPENAPP_RUNTIME_CONTRACT
    ?? "generic-v1";
  if (!SAFE_ID.test(contract)) throw new Error("runtime contract is invalid");
  for (const [label, candidate] of identitySources) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const candidateContract = stringOrUndefined(candidate.runtimeContract) ?? stringOrUndefined(candidate.contract);
    if (candidateContract && candidateContract.toLowerCase() !== contract) {
      throw new Error(`${label} contract does not match composition contract`);
    }
  }
  const profile = explicitProfile ?? parsed.profile ?? {
    environmentKind: parsed.environmentKind ?? "container",
    workloadClass: parsed.workloadClass ?? "web",
    accessMode: parsed.accessMode ?? "http",
    healthPath: parsed.healthPath ?? "/api/health",
    ...(parsed.containerUser === undefined ? {} : { containerUser: parsed.containerUser }),
    ...(parsed.entrypoint === undefined ? {} : { entrypoint: parsed.entrypoint }),
    ...(parsed.containerPort === undefined ? {} : { containerPort: parsed.containerPort }),
    ...(parsed.contextFiles === undefined ? {} : { contextFiles: parsed.contextFiles }),
  };
  return { contract, profile: stableObject(profile) };
}

async function digestRuntime(root) {
  const candidates = ["runtime", "backend/deployment/runtime"];
  for (const candidate of candidates) {
    if (await exists(join(root, candidate))) return digestOptionalPath(root, candidate);
  }
  throw new Error("runtime source is missing from composition bundle");
}

async function digestOptionalPath(root, path) {
  if (!(await exists(join(root, path)))) return "missing";
  return digestPaths(root, [path]);
}

async function digestPaths(root, paths) {
  const files = [];
  for (const input of paths) await collectFiles(join(root, input), root, files);
  files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  const digest = createHash("sha256");
  for (const file of files) {
    const bytes = await readFile(file.absolute);
    digest.update(`${Buffer.byteLength(file.path)}:${file.path}:${bytes.length}:`);
    digest.update(bytes);
  }
  return digest.digest("hex");
}

async function collectFiles(path, root, files) {
  let info;
  try { info = await lstat(path); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`composition digest rejects symlink: ${path}`);
  if (info.isFile()) {
    const relativePath = relative(root, path).split(sep).join("/");
    if (relativePath === COMPOSITION_LOCK_FILE || relativePath.endsWith("/.DS_Store") || relativePath.includes("/logs/")) return;
    files.push({ path: relativePath, absolute: path });
    return;
  }
  if (!info.isDirectory()) throw new Error(`composition digest rejects special file: ${path}`);
  for (const entry of (await readdir(path)).sort()) {
    if (entry === ".git" || entry === "node_modules" || entry === ".DS_Store" || entry === "logs") continue;
    await collectFiles(join(path, entry), root, files);
  }
}

function validateLockShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("composition lock must be an object");
  if (value.schemaVersion !== COMPOSITION_LOCK_SCHEMA_VERSION) throw new Error("composition lock schema is unsupported");
  for (const key of ["core", "contracts", "adapter", "app", "runtime"]) {
    if (!value[key] || typeof value[key] !== "object") throw new Error(`composition lock field is missing: ${key}`);
  }
  if (!value.adapter.manifest || typeof value.adapter.manifest !== "object" || Array.isArray(value.adapter.manifest)) {
    throw new Error("composition lock field is missing: adapter.manifest");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sourceFingerprint)) throw new Error("composition lock source fingerprint is invalid");
}

function stableObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")));
}

function stableJson(value) { return JSON.stringify(value); }
function stringOrUndefined(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function normalizedId(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!SAFE_ID.test(normalized)) throw new Error(`invalid composition id: ${value}`);
  return normalized;
}
function safeReleasePath(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(normalized)) throw new Error(`invalid release path: ${value}`);
  return normalized;
}
function normalizedPlatform(value) {
  const normalized = String(value ?? "").trim();
  if (!SAFE_PLATFORM.test(normalized)) throw new Error(`invalid target platform: ${value}`);
  return normalized;
}
function normalizedImage(value) {
  const normalized = String(value ?? "").trim();
  if (!SAFE_IMAGE.test(normalized)) throw new Error(`invalid runtime image: ${value}`);
  return normalized;
}
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function readJsonIfPresent(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
async function readTextIfPresent(path) { try { return (await readFile(path, "utf8")).trim(); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; } }
function readEnvExample(root, name) {
  try {
    const source = readFileSync(join(root, ".env.example"), "utf8");
    return source.match(new RegExp(`^${name}=([^\\n]*)$`, "mu"))?.[1]?.trim();
  } catch { return undefined; }
}
async function gitRevision(directory) {
  if (!directory) return "unavailable";
  try { return (await execFileAsync("git", ["-C", directory, "rev-parse", "HEAD"])).stdout.trim() || "unavailable"; }
  catch { return "unavailable"; }
}

function parseArgs(argv) {
  const [command = ""] = argv;
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    options[key] = argv[index + 1]?.startsWith("--") ? true : (argv[index + 1] ?? true);
    if (options[key] !== true) index += 1;
  }
  return { command, options };
}

// macOS 的 /tmp、/var 可能是指向 /private 的符号链接；比较真实路径，
// 否则导出到临时目录时 CLI 会被误判为“仅被 import”，从而漏写锁文件。
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  const { command, options } = parseArgs(process.argv.slice(2));
  try {
    if (command === "create") {
      const lock = await createCompositionLock(options);
      process.stdout.write(`${JSON.stringify({ ok: true, file: join(resolve(options.root ?? "."), COMPOSITION_LOCK_FILE), sourceFingerprint: lock.sourceFingerprint }, null, 2)}\n`);
    } else if (command === "verify") {
      const result = await verifyCompositionLock(options);
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    } else {
      process.stderr.write("usage: composition-lock.mjs <create|verify> --root <bundle> [options]\n");
      process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
