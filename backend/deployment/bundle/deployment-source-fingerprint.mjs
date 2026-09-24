#!/usr/bin/env node

/** 计算通用 bundle 的输入摘要；兼容回滚发布使用独立脚本。 */
import { createHash } from "node:crypto";
import { access, lstat, readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");

async function configuredValue(name) {
  const fromEnvironment = process.env[name]?.trim();
  if (fromEnvironment) return fromEnvironment;
  try {
    const example = await readFile(resolve(root, ".env.example"), "utf8");
    const match = example.match(new RegExp(`^${name}=([^\\n]*)$`, "mu"));
    return match?.[1]?.trim() || "";
  } catch {
    return "";
  }
}

const appId = await configuredValue("OPENAPP_APP_ID") || "openapp";
const adapterId = await configuredValue("OPENAPP_ADAPTER_ID") || appId;
const releasePath = await configuredValue("OPENAPP_RELEASE_PATH")
  || appId;
const inputs = [
  "LICENSE",
  "scripts/release",
  "backend/dist",
  "backend/runtime/dist",
  `adapters/${adapterId}`,
  "packages/contracts",
  "backend/deployment/scripts/build-app-image.sh",
  "backend/deployment/scripts/build-runtime-image.sh",
  "backend/deployment/scripts/verify-runtime-contract.sh",
  "backend/deployment/scripts/validate-adapter-runtime.mjs",
  "backend/deployment/scripts/validate-adapter-manifest.mjs",
  "backend/deployment/runtime",
  "backend/package.json",
  "backend/package-lock.json",
  "backend/runtime/package.json",
  "backend/runtime/package-lock.json",
  "frontend/Dockerfile",
  "frontend/nginx",
  "frontend/web",
  ".env.example",
  ".env.production.example",
  "Caddyfile",
  "README.md",
  "bootstrap-admin.sh",
  "deploy.sh",
  "docker-compose.yml",
  "logs.sh",
  "runtime",
  releasePath,
  "postgres/init",
  "preflight.sh",
  "status.sh",
  "stop.sh",
  "backend/.dockerignore",
  "scripts/deployment-source-fingerprint.mjs",
  "scripts/composition-lock.mjs",
  "scripts/prune-generic-artifacts.mjs",
  "scripts/compatibility-manifest.mjs",
  "scripts/boundary-policy.mjs",
];
const optionalInputs = new Set([
  "backend/deployment/scripts/build-app-image.sh",
  "backend/deployment/scripts/build-runtime-image.sh",
  // 旧包可继续校验；新版存在时必须计入指纹。
  "LICENSE",
  "scripts/release",
  `adapters/${adapterId}`,
  "packages/contracts",
  "runtime",
  "scripts/composition-lock.mjs",
  // 旧包可能没有裁剪工具；新包存在这些输入时必须把内容纳入指纹。
  "scripts/prune-generic-artifacts.mjs",
  "scripts/compatibility-manifest.mjs",
  "scripts/boundary-policy.mjs",
]);
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function collect(path, files) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`deployment fingerprint rejects symlink: ${path}`);
  if (info.isFile()) {
    files.push(path);
    return;
  }
  if (!info.isDirectory()) throw new Error(`deployment fingerprint rejects special file: ${path}`);
  for (const entry of (await readdir(path)).sort()) {
    if (entry === ".DS_Store" || entry === "logs") continue;
    await collect(resolve(path, entry), files);
  }
}

const files = [];
for (const input of inputs) {
  try {
    await collect(resolve(root, input), files);
  } catch (error) {
    if (optionalInputs.has(input) && error?.code === "ENOENT") continue;
    throw error;
  }
}
files.sort((left, right) => left.localeCompare(right, "en"));

const digest = createHash("sha256");
for (const file of files) {
  const path = relative(root, file).split(sep).join("/");
  const content = await readFile(file);
  digest.update(`${Buffer.byteLength(path)}:${path}:${content.length}:`);
  digest.update(content);
}
process.stdout.write(`${digest.digest("hex")}\n`);
