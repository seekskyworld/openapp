import { spawn } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

import {
  authProviderAcceptanceEnvironment,
  dockerAcceptanceEnvironment,
  isolatedAcceptanceEnvironment,
  postgresAcceptanceEnvironment,
} from "./openapp-acceptance-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const hostEnvironment = process.env;
const baseEnvironment = isolatedAcceptanceEnvironment(hostEnvironment);
const requested = new Set(process.argv.slice(2));
const supported = new Set(["--docker", "--postgres", "--regression"]);
for (const option of requested) {
  if (!supported.has(option)) throw new Error(`unknown acceptance option: ${option}`);
}
if (requested.has("--regression") && !requested.has("--docker")) {
  throw new Error("--regression requires --docker because the deployment regression starts disposable containers");
}
const dockerEnvironment = dockerAcceptanceEnvironment(hostEnvironment);
const legacyAcceptance = hostEnvironment.OPENAPP_ACCEPTANCE_LEGACY === "1"
  || hostEnvironment.OPENAPP_ACCEPTANCE_LEGACY === "true";

const gates = [
  gate("Acceptance runner isolation", root, process.execPath, [
    "--test", "--test-reporter=dot",
    "scripts/openapp-acceptance.test.mjs",
  ]),
  gate("Prepare Backend and Runtime", root, npm, ["--prefix", "backend", "run", "build"]),
  gate("M3 user entry and access", resolve(root, "backend"), process.execPath, [
    "--test", "--test-reporter=dot",
    "dist/workspace-access-target.test.js",
    "dist/workspace-execution-model.test.js",
    "dist/workspace-execution-manager.test.js",
  ]),
  gate("M2 lifecycle and rollout batches", resolve(root, "backend"), process.execPath, [
    "--test", "--test-reporter=dot",
    "dist/operation-context.test.js",
    "dist/quota-admission.test.js",
    "dist/rollout-cohort.test.js",
  ]),
  gate("M4 build, artifact, and monitoring", resolve(root, "backend"), process.execPath, [
    "--test", "--test-reporter=dot",
    "dist/artifact-provider.test.js",
    "dist/admin-operations.test.js",
    "dist/generic-release.test.js",
  ]),
  gate("H1-H3 storage and durable deletion contracts", resolve(root, "backend"), process.execPath, [
    "--test", "--test-reporter=dot",
    "dist/workspace-execution-manager.test.js",
    "dist/workspace-execution-runtime-bridge.test.js",
    "runtime/dist/docker-cli-runtime.test.js",
  ]),
  gate("M2-M4 operator and entry UI", resolve(root, "frontend"), process.execPath, [
    "--import", "tsx", "--test", "--test-reporter=dot",
    "tests/admin-container-actions.test.ts",
    "tests/admin-upgrade-rollout.test.ts",
    "tests/admin-upgrade-rollout-ui.test.ts",
    "tests/admin-resource-cleanup.test.ts",
  ]),
  gate("Frontend type contracts", root, npm, ["--prefix", "frontend", "run", "typecheck"]),
  gate("Frontend production bundle", root, npm, ["--prefix", "frontend", "run", legacyAcceptance ? "build" : "build:generic"]),
];

if (requested.has("--regression")) {
  gates.push(
    gate("Complete Backend regression", root, npm, ["--prefix", "backend", "test"]),
    gate("Complete Runtime regression", root, npm, ["--prefix", "backend/runtime", "test"]),
    gate("Complete Frontend regression", root, npm, ["--prefix", "frontend", "test"]),
    gate("Deployment bundle regression", root, npm, ["run", "test:deployment"], dockerEnvironment),
    gate("Local and container profile regression", root, npm, ["run", "test:profiles"]),
  );
}

if (requested.has("--postgres")) {
  // 部署回归会重新生成 generic 产物并从 dist 裁掉集成测试；本门禁自行构建
  // 完整 Backend，避免结果依赖前一个产物类门禁留下的目录状态。
  gates.push(gate("H1 PostgreSQL migration and restart compatibility", root, npm, [
    "--prefix", "backend", "run", "test:postgres",
  ], postgresAcceptanceEnvironment(hostEnvironment)));
}

if (requested.has("--docker")) {
  const image = hostEnvironment.OPENAPP_RUNTIME_ACCEPTANCE_IMAGE?.trim();
  if (!image) throw new Error("OPENAPP_RUNTIME_ACCEPTANCE_IMAGE is required for --docker");
  gates.push(gate("Disposable Docker storage lifecycle", resolve(root, "backend/runtime"), process.execPath, [
    "--test", "--test-reporter=dot",
    "dist/docker-cli-runtime.integration.test.js",
  ], {
    ...dockerEnvironment,
    ...authProviderAcceptanceEnvironment(hostEnvironment, { legacy: legacyAcceptance }),
    OPENAPP_RUNTIME_ACCEPTANCE: "1",
    OPENAPP_RUNTIME_ACCEPTANCE_PROFILE: hostEnvironment.OPENAPP_RUNTIME_ACCEPTANCE_PROFILE ?? "",
    OPENAPP_RUNTIME_ACCEPTANCE_IMAGE: image,
    ...(hostEnvironment.TARGET_PLATFORM
      ? { TARGET_PLATFORM: hostEnvironment.TARGET_PLATFORM }
      : {}),
  }));
}

const results = [];
for (const item of gates) {
  const startedAt = Date.now();
  process.stdout.write(`\n[RUN] ${item.name}\n`);
  const exitCode = await run(item);
  const durationMs = Date.now() - startedAt;
  results.push({ name: item.name, exitCode, durationMs });
  process.stdout.write(`[${exitCode === 0 ? "PASS" : "FAIL"}] ${item.name} (${durationMs} ms)\n`);
  if (exitCode !== 0) break;
}

process.stdout.write("\nAcceptance summary\n");
for (const result of results) {
  process.stdout.write(`- ${result.exitCode === 0 ? "PASS" : "FAIL"}: ${result.name}\n`);
}
if (results.some((result) => result.exitCode !== 0) || results.length !== gates.length) {
  process.exitCode = 1;
}

function gate(name, cwd, command, args, environment = {}) {
  return { name, cwd, command, args, environment };
}

function run(item) {
  return new Promise((resolveExit) => {
    const child = spawn(item.command, item.args, {
      cwd: item.cwd,
      env: { ...baseEnvironment, ...item.environment },
      stdio: "inherit",
    });
    child.once("error", (error) => {
      process.stderr.write(`${error.message}\n`);
      resolveExit(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) process.stderr.write(`acceptance gate terminated by ${signal}\n`);
      resolveExit(code ?? 1);
    });
  });
}
