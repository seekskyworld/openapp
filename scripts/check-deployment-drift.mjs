#!/usr/bin/env node
/**
 * 校验已导出的部署目录是否仍与仓库构建输入一致；部署前失败可以避免
 * 把旧的 dist、前端资源或 业务包误发到服务器。
 */
import { access, lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root = resolve(process.argv[2] ?? ".");
const deployment = resolve(process.argv[3] ?? "deployment");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fingerprint(path) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [fingerprintScript, path], { cwd: deployment });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `fingerprint exited with ${code}`));
        return;
      }
      resolvePromise(stdout.trim());
    });
  });
}

if (!(await exists(deployment))) {
  console.error(`deployment directory does not exist: ${deployment}`);
  process.exit(2);
}

// 指纹脚本必须随 bundle 一起发布。这样 generic 和 legacy 都只验证实际要
// 部署的文件集合；Core checkout 删除旧兼容目录后，历史回滚包仍然自包含。
const fingerprintScript = resolve(deployment, "scripts/deployment-source-fingerprint.mjs");
let fingerprintInfo;
try {
  fingerprintInfo = await lstat(fingerprintScript);
} catch {
  console.error(`deployment fingerprint script is missing: ${fingerprintScript}`);
  console.error("export a new self-contained bundle before deploying");
  process.exit(1);
}
if (!fingerprintInfo.isFile() || fingerprintInfo.isSymbolicLink()) {
  console.error(`deployment fingerprint script must be a regular file: ${fingerprintScript}`);
  process.exit(1);
}

const markerPath = resolve(deployment, ".openapp-source-fingerprint");
if (!(await exists(markerPath))) {
  console.error(`deployment fingerprint marker is missing: ${markerPath}`);
  console.error("export a clean bundle with scripts/export-deployment-bundle.sh before deploying");
  process.exit(1);
}
const actual = (await readFile(markerPath, "utf8")).trim();
const expected = await fingerprint(deployment);
if (!/^[a-f0-9]{64}$/u.test(actual) || actual !== expected) {
  console.error(`deployment source drift detected: marker=${actual || "<empty>"}, actual=${expected}`);
  process.exit(1);
}
process.stdout.write(`deployment source fingerprint verified: ${actual}\n`);
