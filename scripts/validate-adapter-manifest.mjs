#!/usr/bin/env node

/**
 * 在导出部署包前验证已编译 Adapter 的身份合同。
 *
 * `OPENAPP_ADAPTER_ID` 是 bundle 中的插件槽位，App id 则由 Adapter manifest
 * 决定。当前发布模型采用一对一映射：槽位、manifest 和本次组合的 App 必须
 * 相同，避免把一个产品的认证、Runtime 或品牌悄悄装到另一个 App 上。
 * 这里只用空环境实例化 factory，不调用 Provider、数据库或 Docker。
 */
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const API_VERSION = "v2";

function usage() {
  return "usage: validate-adapter-manifest.mjs --adapter-root <path> --app-id <id> [--adapter-id <id>] [--print-identity]";
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

async function requireRegularFile(path, label) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error(`${label} symlink is not allowed: ${path}`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function selectFactory(namespace) {
  const candidates = [
    namespace.default,
    namespace.openAppAdapterFactory,
    namespace.createOpenAppAdapter,
    namespace.createAdapter,
  ];
  const factory = candidates.find((candidate) => typeof candidate === "function");
  if (!factory) throw new Error("Adapter module does not export an adapter factory");
  return factory;
}

function inertReleaseInspector() {
  const unavailable = async () => {
    throw new Error("release inspection is not available during manifest validation");
  };
  return {
    inspectBackendRelease: unavailable,
    inspectWebRelease: unavailable,
    inspectReleasePackages: unavailable,
  };
}

async function loadManifest(adapterRoot, modulePath) {
  let namespace;
  try {
    namespace = await import(`${pathToFileURL(modulePath).href}?openapp_manifest_validation=${Date.now()}`);
  } catch (error) {
    throw new Error(`Adapter module could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  const factory = selectFactory(namespace);
  let adapter;
  try {
    adapter = await factory({
      environment: Object.freeze({}),
      releaseInspector: inertReleaseInspector(),
    });
  } catch (error) {
    throw new Error(`Adapter factory failed during manifest validation: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!adapter || typeof adapter !== "object") throw new Error("Adapter factory did not return an object");
  return adapter.manifest;
}

async function loadContracts(explicitPath) {
  const candidates = [
    explicitPath,
    resolve(SCRIPT_DIR, "..", "..", "..", "packages/contracts/dist/index.js"),
    resolve(SCRIPT_DIR, "..", "packages/contracts/dist/index.js"),
    resolve(process.cwd(), "packages/contracts/dist/index.js"),
  ].filter(Boolean);
  let contractsPath;
  for (const candidate of candidates) {
    try {
      await requireRegularFile(candidate, "built contracts module");
      contractsPath = candidate;
      break;
    } catch (error) {
      if (!String(error?.message ?? "").includes("is missing:")) throw error;
    }
  }
  if (!contractsPath) {
    throw new Error("built contracts module is missing; build packages/contracts before validating an Adapter");
  }
  try {
    return await import(`${pathToFileURL(contractsPath).href}?openapp_manifest_contract=${Date.now()}`);
  } catch (error) {
    throw new Error(`built contracts module could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function validateRuntimeMetadata(adapterRoot, manifest) {
  const runtimeRoot = resolve(adapterRoot, "runtime");
  let runtimeInfo;
  try {
    runtimeInfo = await lstat(runtimeRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (runtimeInfo.isSymbolicLink() || !runtimeInfo.isDirectory()) {
    throw new Error(`Adapter Runtime directory must be a regular directory: ${runtimeRoot}`);
  }
  const profilePath = join(runtimeRoot, "profile.json");
  await requireRegularFile(profilePath, "Adapter Runtime profile");
  const profile = await readJson(profilePath, "Adapter Runtime profile");
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("Adapter Runtime profile must be an object");
  }
  if (profile.appId === undefined) {
    throw new Error("Adapter Runtime profile appId is required for an external Adapter");
  }
  const profileAppId = normalizedId(profile.appId, "Adapter Runtime profile appId");
  if (profileAppId !== manifest.id) {
    throw new Error(`Adapter Runtime profile appId does not match manifest id: ${profileAppId}`);
  }
  const profileContract = typeof profile.runtimeContract === "string" ? profile.runtimeContract : profile.contract;
  if (profileContract === undefined) {
    throw new Error("Adapter Runtime profile contract is required");
  }
  if (String(profileContract).trim().toLowerCase() !== manifest.workload.runtimeContract) {
    throw new Error("Adapter Runtime profile contract does not match manifest workload");
  }
  for (const key of ["environmentKind", "workloadClass", "accessMode", "healthPath"]) {
    if (profile[key] !== undefined && !isDeepStrictEqual(profile[key], manifest.workload[key])) {
      throw new Error(`Adapter Runtime profile ${key} does not match manifest workload`);
    }
  }
  const declaredRuntime = manifest.workload.runtime;
  if (declaredRuntime) {
    for (const key of [
      "id",
      "contract",
      "environmentPrefix",
      "defaultImage",
      "defaultNetworkPrefix",
      "defaultContainerPrefix",
      "defaultVolumePrefix",
      "labelPrefix",
      "storageClass",
      "storageMountPath",
      "containerPort",
      "containerUser",
      "entrypoint",
      "command",
      "recoveryCommand",
      "configEnvironmentKey",
      "lockRecoveryEnvironment",
      "reservedEnvironment",
      "healthPath",
      "providerEnvironment",
      "legacyResourcePrefixes",
    ]) {
      if (declaredRuntime[key] === undefined && key !== "recoveryCommand" && key !== "lockRecoveryEnvironment") continue;
      if (!isDeepStrictEqual(profile[key], declaredRuntime[key])) {
        throw new Error(`Adapter Runtime profile ${key} does not match manifest runtime`);
      }
    }
  }
}

/**
 * legacy manifest 属于同一个 Adapter 发布面；即使本次导出走 generic 路径，
 * 也不能允许它悄悄指向另一个 App 或版本，否则回滚时会组合出错误的运行时。
 */
async function validateOptionalLegacyIdentity(adapterRoot, manifest, packageVersion) {
  const path = join(adapterRoot, "deployment", "legacy", "manifest.json");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Adapter legacy manifest must be a regular file: ${path}`);
  const legacy = await readJson(path, "Adapter legacy release manifest");
  if (normalizedId(legacy.appId, "Adapter legacy appId") !== manifest.id) {
    throw new Error("Adapter legacy manifest appId does not match manifest id");
  }
  if (normalizedId(legacy.adapterId, "Adapter legacy adapterId") !== manifest.id) {
    throw new Error("Adapter legacy manifest adapterId does not match manifest id");
  }
  if (typeof legacy.version !== "string" || legacy.version.trim() !== packageVersion) {
    throw new Error("Adapter legacy manifest version does not match Adapter package version");
  }
}

/**
 * 迁移描述必须和 manifest 声明的发布摘要绑定。只校验 manifest 中的字符串会
 * 允许部署包替换实际 descriptor，导致回滚/审计看到的迁移证据与发布版本不同。
 */
async function validateMigrationDescriptorChecksum(adapterRoot, manifest) {
  const migration = manifest.compatibility?.migration;
  if (!migration) return;
  const path = join(adapterRoot, "deployment", "legacy", "migration-plan.json");
  await requireRegularFile(path, "Adapter migration plan");
  const actual = createHash("sha256").update(await readFile(path)).digest("hex");
  const declared = String(migration.checksum).trim().toLowerCase().replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(declared) || actual !== declared) {
    throw new Error(`Adapter migration plan checksum does not match manifest: ${path}`);
  }
}

/**
 * 验证 Adapter 包的实际运行身份，并返回经过 contracts 校验的 manifest。
 */
export async function validateAdapterManifest(options = {}) {
  const adapterRoot = resolve(options.adapterRoot ?? "");
  const expectedAppId = normalizedId(options.appId, "requested App id");
  const expectedAdapterId = options.adapterId === undefined
    ? undefined
    : normalizedId(options.adapterId, "requested Adapter id");
  const packagePath = join(adapterRoot, "package.json");
  const modulePath = join(adapterRoot, "dist/index.js");
  await requireRegularFile(packagePath, "Adapter package manifest");
  await requireRegularFile(modulePath, "Adapter production module");
  const packageManifest = await readJson(packagePath, "Adapter package manifest");
  const manifest = await loadManifest(adapterRoot, modulePath);
  const contracts = await loadContracts(options.contractsModule);
  let validated;
  try {
    validated = contracts.validateAdapterManifest(manifest);
  } catch (error) {
    throw new Error(`Adapter manifest contract is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (validated.apiVersion !== API_VERSION) {
    throw new Error(`Adapter API version is unsupported: ${validated.apiVersion}`);
  }
  if (validated.id !== expectedAppId) {
    throw new Error(`Adapter manifest id does not match requested App: ${validated.id}`);
  }
  if (expectedAdapterId !== undefined && validated.id !== expectedAdapterId) {
    throw new Error(`Adapter manifest id does not match Adapter slot: ${validated.id}`);
  }
  if (validated.build && validated.build.runtimeContract !== validated.workload.runtimeContract) {
    throw new Error("Adapter build runtimeContract does not match workload");
  }
  if (validated.catalogBootstrap && validated.catalogBootstrap.runtimeContract !== validated.workload.runtimeContract) {
    throw new Error("Adapter catalog runtimeContract does not match workload");
  }
  const packageName = typeof packageManifest.name === "string" && packageManifest.name.trim()
    ? packageManifest.name.trim()
    : undefined;
  const packageVersion = typeof packageManifest.version === "string" && packageManifest.version.trim()
    ? packageManifest.version.trim()
    : undefined;
  if (!packageName) throw new Error("Adapter package name is missing");
  if (!packageVersion) throw new Error("Adapter package version is missing");
  if (packageVersion !== validated.version) {
    throw new Error(`Adapter package version does not match manifest version: ${packageVersion}`);
  }
  await validateRuntimeMetadata(adapterRoot, validated);
  await validateOptionalLegacyIdentity(adapterRoot, validated, packageVersion);
  await validateMigrationDescriptorChecksum(adapterRoot, validated);
  return Object.freeze({
    adapterRoot,
    modulePath,
    packageName,
    packageVersion,
    manifest: validated,
  });
}

/**
 * 只导出组合验证所需的非敏感身份字段。完整 manifest 仍由 Adapter 运行模块
 * 提供，部署包不额外复制可能随能力扩展而变化的业务配置。
 */
export function adapterManifestIdentity(result) {
  return Object.freeze({
    apiVersion: result.manifest.apiVersion,
    id: result.manifest.id,
    version: result.manifest.version,
    runtimeContract: result.manifest.workload.runtimeContract,
  });
}

function parseArgs(argv) {
  return {
    adapterRoot: option(argv, "--adapter-root"),
    appId: option(argv, "--app-id"),
    adapterId: option(argv, "--adapter-id"),
    contractsModule: option(argv, "--contracts-module"),
    printIdentity: argv.includes("--print-identity"),
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.adapterRoot || !args.appId) throw new Error(usage());
    const result = await validateAdapterManifest(args);
    if (args.printIdentity) {
      process.stdout.write(`${JSON.stringify(adapterManifestIdentity(result), null, 2)}\n`);
    } else {
      process.stdout.write(`Adapter manifest valid (${result.manifest.id}, ${result.manifest.version})\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
