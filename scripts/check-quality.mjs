/** 只检查可发布源码；历史格式例外绑定内容摘要，修改后必须符合当前格式。 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { ESLint } from "eslint";
import * as prettier from "prettier";
const files = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => file && existsSync(file)),
  ),
];
const baselinePath = "config/format-baseline.json";
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
const options = JSON.parse(readFileSync(".prettierrc.json", "utf8"));
const current = {};
for (const file of files) {
  const info = await prettier.getFileInfo(file, { ignorePath: ".prettierignore" });
  if (info.ignored || !info.inferredParser) continue;
  const source = readFileSync(file, "utf8");
  if (!(await prettier.check(source, { ...options, filepath: file })))
    current[file] = { sha256: createHash("sha256").update(source).digest("hex") };
}
if (process.argv.includes("--print-baseline")) {
  process.stdout.write(JSON.stringify(current, null, 2) + "\n");
} else {
  const changed = Object.keys(current).filter((file) => current[file].sha256 !== baseline[file]?.sha256);
  if (changed.length) {
    console.error("Format these changed/new files with Prettier:\n" + changed.join("\n"));
    process.exitCode = 1;
  }
  const eslint = new ESLint();
  const results = await eslint.lintFiles(files.filter((file) => /\.(m?js|tsx?)$/.test(file)));
  const report = (await eslint.loadFormatter("stylish")).format(results);
  if (report) process.stdout.write(report);
  if (results.some((result) => result.errorCount)) process.exitCode = 1;
  if (!process.exitCode) console.log("Source lint and formatting checks passed");
}
