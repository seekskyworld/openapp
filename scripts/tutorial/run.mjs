/** 执行教程中标记的原始命令，防止文档与另写的测试步骤各自正确却互不对应。 */
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import {
  isolatedAcceptanceEnvironment,
  dockerAcceptanceEnvironment,
} from "../openapp-acceptance-environment.mjs";

const root = resolve(import.meta.dirname, "../..");
const language = process.argv.find((arg) => arg.startsWith("--lang="))?.slice(7) ?? "en";
if (!["en", "zh-CN"].includes(language)) throw Error("tutorial language must be en or zh-CN");
const documents = await Promise.all(
  ["adapter-tutorial.en.md", "adapter-tutorial.md"].map((name) => readFile(join(root, "docs", name), "utf8")),
);
const documentSteps = documents.map((document) =>
  [...document.matchAll(/```bash\n# tutorial:([a-z-]+)\n([\s\S]*?)\n```/g)].map((match) => ({
    name: match[1],
    command: match[2],
  })),
);
// 两种语言必须执行同一组命令，避免翻译更新后仍只验收另一份教程。
assert.deepEqual(documentSteps[0], documentSteps[1], "English and Chinese tutorial commands have drifted");
const steps = documentSteps[language === "en" ? 0 : 1];
const lab = await mkdtemp(join(tmpdir(), "openapp-tutorial-"));
const environment = {
  ...isolatedAcceptanceEnvironment(process.env),
  ...dockerAcceptanceEnvironment(process.env),
  CORE_ROOT: root,
  LAB_ROOT: lab,
};
environment.TARGET_PLATFORM = execFileSync(
  "docker",
  ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
  { encoding: "utf8", env: environment },
).trim();
const expected = [
  "dependencies",
  "copy",
  "sdk",
  "app-image",
  "compose",
  "control-images",
  "configure",
  "start",
  "bootstrap",
  "verify",
];
if (JSON.stringify(steps.map((step) => step.name)) !== JSON.stringify(expected))
  throw Error("tutorial steps missing or reordered; update the runner deliberately");
const run = (command, env = environment) =>
  new Promise((resolve, reject) => {
    const child = spawn("bash", ["-euo", "pipefail", "-c", command], { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(Error(`tutorial step exited ${code}`))));
  });
console.log(`New independent tutorial workspace (${language}): ${lab}`);
await writeFile(join(lab, "tutorial-progress.json"), JSON.stringify({ steps: [], status: "running" }));
const completed = [];
try {
  for (const step of steps) {
    console.log(`\n[TUTORIAL] ${step.name}`);
    const env =
      step.name === "bootstrap"
        ? {
            ...environment,
            OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.test",
            OPENAPP_BOOTSTRAP_SUPER_ADMIN_PASSWORD: randomBytes(24).toString("hex"),
          }
        : environment;
    await run(step.command, env);
    completed.push(step.name);
    await writeFile(
      join(lab, "tutorial-progress.json"),
      JSON.stringify({ steps: completed, status: "running" }, null, 2),
    );
  }
  for (const name of [
    "backend/server.mjs",
    "frontend/index.html",
    "frontend/app.js",
    "frontend/style.css",
    "Dockerfile",
    "start.sh",
  ]) {
    assert.deepEqual(
      await readFile(join(lab, "notes-app", name)),
      await readFile(join(root, "examples/notes-app", name)),
      `business source changed: ${name}`,
    );
  }
  await writeFile(
    join(lab, "tutorial-progress.json"),
    JSON.stringify({ steps: completed, status: "passed", applicationSourceUnchanged: true }, null, 2),
  );
  console.log(`\nAll tutorial commands passed. Evidence and independent repositories: ${lab}`);
} catch (error) {
  await writeFile(
    join(lab, "tutorial-progress.json"),
    JSON.stringify({ steps: completed, status: "failed", error: error.message }, null, 2),
  );
  throw error;
} finally {
  if (!process.argv.includes("--keep-running")) {
    // 只停止本次带随机身份的服务，保留数据和证据；不执行全局 prune。
    try {
      await run('node "$CORE_ROOT/scripts/tutorial/stop.mjs" "$LAB_ROOT/release"');
    } catch (error) {
      console.error(`Tutorial stop did not complete; inspect ${lab}: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
