import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("..", import.meta.url).pathname.replace(/\/$/u, "");

test("Core deployment templates do not own application-specific package slots", async () => {
  for (const name of ["deploy.sh", "preflight.sh"]) await assert.rejects(access(join(root, "backend/deployment/bundle", name)), { code: "ENOENT" });
  for (const name of [".env.example", ".env.production.example"]) {
    const source = await readFile(join(root, "backend/deployment/bundle", name), "utf8");
    assert.doesNotMatch(source, /OPENAPP_(?:RELEASE_BACKEND_PATH|RELEASE_WEB_PATH|BACKEND_PACKAGE_GLOB|WEB_PACKAGE_GLOB)/);
  }
});

test("deployment drift checker requires a generated fingerprint marker", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "openapp-drift-"));
  try {
    await mkdir(join(deployment, "scripts"), { recursive: true });
    await writeFile(
      join(deployment, "scripts/deployment-source-fingerprint.mjs"),
      `process.stdout.write("${"a".repeat(64)}\\n");\n`,
    );
    await assert.rejects(
      execFileAsync(process.execPath, [join(root, "scripts/check-deployment-drift.mjs"), root, deployment]),
      /fingerprint marker is missing/u,
    );
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("deployment drift checker requires the fingerprint script inside the bundle", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openapp-drift-self-contained-"));
  const deployment = join(fixtureRoot, "deployment");
  try {
    await mkdir(deployment, { recursive: true });
    await writeFile(join(deployment, ".openapp-source-fingerprint"), `${"a".repeat(64)}\n`);
    await assert.rejects(
      execFileAsync(process.execPath, [join(root, "scripts/check-deployment-drift.mjs"), fixtureRoot, deployment]),
      /fingerprint script is missing/u,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("deployment drift checker accepts the marker generated from the same bundle", async () => {
  const deployment = await mkdtemp(join(tmpdir(), "openapp-drift-"));
  try {
    await mkdir(join(deployment, "backend/dist"), { recursive: true });
    await mkdir(join(deployment, "backend/runtime/dist"), { recursive: true });
    await mkdir(join(deployment, "backend/deployment"), { recursive: true });
    // fingerprint 现在包含通用部署脚本和 Runtime 根目录，fixture 必须与导出包布局一致。
    await mkdir(join(deployment, "backend/deployment/scripts"), { recursive: true });
    await mkdir(join(deployment, "backend/deployment/runtime"), { recursive: true });
    await mkdir(join(deployment, "frontend/nginx"), { recursive: true });
    await mkdir(join(deployment, "frontend/web"), { recursive: true });
    await mkdir(join(deployment, "openapp/backend"), { recursive: true });
    await mkdir(join(deployment, "openapp/frontend"), { recursive: true });
    await mkdir(join(deployment, "runtime"), { recursive: true });
    await mkdir(join(deployment, "adapters/demo-auth"), { recursive: true });
    await mkdir(join(deployment, "postgres/init"), { recursive: true });
    await mkdir(join(deployment, "scripts"), { recursive: true });
    const requiredFiles = [
      "LICENSE", "scripts/release/build-openapp.sh", "scripts/release/compose-files.sh",
      "backend/package.json", "backend/package-lock.json", "backend/runtime/package.json",
      "backend/runtime/package-lock.json", "frontend/Dockerfile", "frontend/nginx/default.conf",
      "backend/deployment/scripts/build-app-image.sh",
      "backend/deployment/scripts/build-runtime-image.sh",
      "backend/deployment/scripts/verify-runtime-contract.sh",
      "backend/deployment/scripts/validate-adapter-runtime.mjs",
      "backend/deployment/scripts/validate-adapter-manifest.mjs",
      "frontend/web/index.html", ".env.example", ".env.production.example", "Caddyfile",
      "README.md", "bootstrap-admin.sh", "deploy.sh", "docker-compose.yml", "logs.sh",
      "runtime/Dockerfile", "runtime/start.sh", "runtime/recover-state-locks.mjs", "runtime/profile.json",
      "openapp/backend/openapp-1.0.0.tgz", "openapp/frontend/openapp-web-1.0.0.tar.gz",
      "adapters/demo-auth/package.json", "adapters/demo-auth/dist/index.js",
      "postgres/init/001-container_service.sql", "preflight.sh", "status.sh", "stop.sh",
      "backend/.dockerignore", "scripts/deployment-source-fingerprint.mjs",
    ];
    for (const relative of requiredFiles) {
      const path = join(deployment, relative);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, path.endsWith(".env.example")
        ? "OPENAPP_APP_ID=openapp\nOPENAPP_ADAPTER_ID=demo-auth\nOPENAPP_RELEASE_PATH=openapp\n"
        : "fixture");
    }
    const fingerprintScript = join(deployment, "scripts/deployment-source-fingerprint.mjs");
    await writeFile(fingerprintScript, await (await import("node:fs/promises")).readFile(
      join(root, "backend/deployment/bundle/deployment-source-fingerprint.mjs"),
    ));
    const { stdout } = await execFileAsync(process.execPath, [fingerprintScript, deployment]);
    await writeFile(join(deployment, ".openapp-source-fingerprint"), stdout.trim());
    const result = await execFileAsync(process.execPath, [join(root, "scripts/check-deployment-drift.mjs"), root, deployment]);
    assert.match(result.stdout, /fingerprint verified/u);
    // 分包依赖的公共脚本和许可证也必须受源指纹保护。
    for (const relative of ["LICENSE", "scripts/release/build-openapp.sh", "scripts/release/compose-files.sh"]) {
      await writeFile(join(deployment, relative), "modified");
      const changed = await execFileAsync(process.execPath, [fingerprintScript, deployment]);
      assert.notEqual(changed.stdout.trim(), stdout.trim(), relative);
      await writeFile(join(deployment, relative), "fixture");
    }
  } finally {
    await rm(deployment, { recursive: true, force: true });
  }
});

test("deployment drift checker uses the fingerprint shipped by a legacy bundle", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openapp-legacy-drift-root-"));
  const deployment = join(fixtureRoot, "deployment");
  const legacyDigest = "b".repeat(64);
  try {
    await Promise.all([
      mkdir(join(fixtureRoot, "backend/deployment/sample-app"), { recursive: true }),
      mkdir(join(deployment, "scripts"), { recursive: true }),
      mkdir(deployment, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(deployment, "scripts/deployment-source-fingerprint.mjs"),
        `process.stdout.write("${legacyDigest}\\n");\n`,
      ),
      writeFile(join(deployment, ".env.example"), "OPENAPP_BUNDLE_LEGACY_LAYOUT=true\n"),
      writeFile(join(deployment, ".openapp-source-fingerprint"), `${legacyDigest}\n`),
    ]);

    const result = await execFileAsync(process.execPath, [
      join(root, "scripts/check-deployment-drift.mjs"),
      fixtureRoot,
      deployment,
    ]);
    assert.match(result.stdout, new RegExp(legacyDigest, "u"));

    // A stale Core compatibility script must not affect the result anymore.
    await writeFile(
      join(fixtureRoot, "backend/deployment/sample-app/legacy-deployment-source-fingerprint.mjs"),
      `process.stdout.write("${"c".repeat(64)}\\n");\n`,
    );
    const stable = await execFileAsync(process.execPath, [
      join(root, "scripts/check-deployment-drift.mjs"),
      fixtureRoot,
      deployment,
    ]);
    assert.match(stable.stdout, new RegExp(legacyDigest, "u"));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
