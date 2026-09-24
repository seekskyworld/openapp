/** 自动发现单元测试，集成测试仍由显式数据库/Docker 验收入口执行。 */
import { readdirSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
function discover(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? discover(file)
      : /\.test\.js$/.test(file) && !file.endsWith(".integration.test.js")
        ? [file]
        : [];
  });
}
const coverage = process.argv.includes("--coverage");
const report = resolve("../.cache/backend.lcov");
if (coverage) mkdirSync(resolve("../.cache"), { recursive: true });
const args = coverage
  ? [
      "--experimental-test-coverage",
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${report}`,
    ]
  : [];
const files = [
  ...discover("dist"),
  ...readdirSync("deployment/scripts")
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => join("deployment/scripts", name)),
];
const result = spawnSync(process.execPath, [...args, "--test", ...files], { stdio: "inherit" });
process.exitCode = result.status ?? 1;
