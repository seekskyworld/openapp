/** 只扫描 Git 发布候选文件，不复制被忽略的数据库、凭据、缓存或历史。 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, lstatSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "openapp-secret-scan-"));
try {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  for (const path of new Set(files)) {
    let info;
    try {
      info = lstatSync(join(root, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile()) throw Error(`release source must be a regular file: ${path}`);
    mkdirSync(dirname(join(temporary, path)), { recursive: true });
    copyFileSync(join(root, path), join(temporary, path));
  }
  const report = join(temporary, "scan-findings.json");
  try {
    execFileSync(
      "gitleaks",
      ["dir", temporary, "--redact", "--no-banner", "--report-format", "json", "--report-path", report],
      { stdio: "inherit" },
    );
  } catch (error) {
    if (!existsSync(report)) throw error;
    const findings = JSON.parse(readFileSync(report, "utf8"));
    for (const finding of findings) console.error(`${finding.RuleID}: ${finding.File}:${finding.StartLine}`);
    process.exitCode = 1;
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
