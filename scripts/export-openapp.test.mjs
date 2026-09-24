import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const run = promisify(execFile);
test(
  "two unrelated adapters export without business packages and load with independent entry manifests",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "openapp-multi-export-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const plugins = [];
    for (const id of ["alpha", "beta"]) {
      const source = join(root, id);
      await mkdir(join(source, "dist"), { recursive: true });
      await mkdir(join(source, "dist/testing"), { recursive: true });
      await writeFile(join(source, "dist/testing/reference.js"), 'throw Error("test-only");');
      await writeFile(
        join(source, "package.json"),
        JSON.stringify({
          name: `test-${id}`,
          version: "1.0.0",
          type: "module",
          scripts: { build: "node --check dist/index.js" },
        }),
      );
      await mkdir(join(source, "assets"));
      await writeFile(
        join(source, "assets/auth-ui.mjs"),
        "export const apiVersion = 1; export const createAuthCompatibility = () => ({});",
      );
      const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
      metadata.openapp = { authUi: { apiVersion: 1, providerId: id, module: "auth-ui.mjs" } };
      await writeFile(join(source, "package.json"), JSON.stringify(metadata));
      await writeFile(
        join(source, "dist/index.js"),
        `export default () => ({manifest: {
      id: "${id}", apiVersion: "v2", version: "1.0.0", name: "${id}", description: "",
      entry: {id: "${id}", label: "${id}", logoUrl: "https://example.test/${id}.png", challenge: "none", defaultWorkspace: "personal"},
      capabilities: {}, workload: {runtimeContract: "generic-v1", environmentKind: "container", workloadClass: "web", accessMode: "http", healthPath: "/health"}
    }});`,
      );
      await writeFile(join(source, ".env"), "DO_NOT_SHIP=secret");
      plugins.push({ id, source, version: "1.0.0" });
    }
    const config = join(root, "release.json");
    await writeFile(
      config,
      JSON.stringify({ schemaVersion: 1, defaultAppId: "alpha", compatibilityMode: false, plugins }),
    );
    const output = join(root, "output");
    await run(process.execPath, ["scripts/export-openapp.mjs", config, output], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const catalog = JSON.parse(await readFile(join(output, "core/plugins.json"), "utf8"));
    assert.deepEqual(
      catalog.plugins.map((p) => p.id),
      ["alpha", "beta"],
    );
    const authCatalog = JSON.parse(
      await readFile(join(output, "core/frontend/web/auth-adapters.json"), "utf8"),
    );
    assert.deepEqual(authCatalog, {
      schemaVersion: 1,
      defaultProviderId: "alpha",
      providers: {
        alpha: "/adapter-assets/alpha/auth-ui.mjs",
        beta: "/adapter-assets/beta/auth-ui.mjs",
      },
    });
    assert.ok((await readdir(output)).includes("openapp-beta-adapter"));
    const manifest = JSON.parse(await readFile(join(output, "release-manifest.json"), "utf8"));
    for (const path of ["LICENSE", "core/frontend/web/LICENSE", "core/packages/contracts/LICENSE"]) {
      assert.ok(manifest.files[path], `license must be verified: ${path}`);
      assert.match(await readFile(join(output, path), "utf8"), /Version 2.0, January 2004/);
    }
    assert.ok(!Object.keys(manifest.files).some((p) => p.endsWith("/.env") || /\.(tgz|tar.gz)$/.test(p)));
    assert.ok(
      !Object.keys(manifest.files).some((p) => /\/(testing|tests)\//.test(p) || /\.(test|spec)\./.test(p)),
    );
    assert.ok(
      !Object.keys(manifest.files).some((p) => /^core\/backend\/(?:runtime\/)?dist\/.*\.d\.ts$/.test(p)),
    );
    assert.ok(manifest.files["core/bootstrap-admin.sh"]);
    assert.ok(manifest.files["third-party/backend.cdx.json"]);
    const notices = await readFile(join(output, "third-party/backend-LICENSES.txt"), "utf8");
    assert.match(notices, /README.md license section/);
    assert.doesNotMatch(notices, /not declared|No license text/);
    const provenance = JSON.parse(await readFile(join(output, "source-provenance.json"), "utf8"));
    assert.equal(provenance.releaseMode, "development");
    assert.deepEqual(
      provenance.plugins.map((p) => p.id),
      ["alpha", "beta"],
    );
    const dockerfile = await readFile(join(output, "core/backend/Dockerfile"), "utf8");
    await verifyBuildScriptPermissions(t, dockerfile);
    // 在导出目录运行实际脚本，确保它的模块依赖随部署包一起交付。
    const pruned = await run(process.execPath, [
      join(output, "scripts/prune-generic-artifacts.mjs"),
      "--root",
      join(output, "core"),
    ]);
    assert.deepEqual(
      JSON.parse(pruned.stdout).removed,
      [],
      "export must already match the image's artifact policy",
    );
    assert.match(dockerfile, /COPY openapp-alpha-adapter\/ .\/adapters\/alpha\//);
    assert.match(dockerfile, /COPY openapp-beta-adapter\/ .\/adapters\/beta\//);
    const { loadConfiguredAppPlugins } = await import("../backend/dist/portal-context-core.js");
    const { PlatformPluginRegistry } = await import("../backend/dist/platform-plugins.js");
    for (const entry of catalog.plugins)
      entry.module = join(output, `openapp-${entry.id}-adapter/dist/index.js`);
    const localCatalog = join(root, "runtime.json");
    await writeFile(localCatalog, JSON.stringify(catalog));
    const loaded = await loadConfiguredAppPlugins({
      artifacts: {},
      environment: {
        OPENAPP_APP_ID: "alpha",
        OPENAPP_ADAPTER_CATALOG: localCatalog,
        OPENAPP_ADAPTER_ALLOWED_ROOTS: output,
      },
    });
    const registry = new PlatformPluginRegistry(loaded);
    assert.equal(registry.workspaceEntryManifest("alpha").entry.label, "alpha");
    assert.equal(registry.workspaceEntryManifest("beta").entry.label, "beta");
    await run(process.execPath, [join(output, "verify.mjs")]);
    await rm(join(output, "openapp-beta-adapter/dist/index.js"));
    await assert.rejects(
      run(process.execPath, [join(output, "verify.mjs")]),
      /missing, modified or unexpected/,
    );
    await writeFile(
      config,
      JSON.stringify({ schemaVersion: 1, defaultAppId: "alpha", compatibilityMode: true, plugins }),
    );
    const compatibilityOutput = join(root, "compatibility-output");
    await run(process.execPath, ["scripts/export-openapp.mjs", config, compatibilityOutput], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const compatibilityDockerfile = await readFile(
      join(compatibilityOutput, "core/backend/Dockerfile"),
      "utf8",
    );
    assert.doesNotMatch(compatibilityDockerfile, /RUN node \/tmp\/prune/);
    await verifyBuildScriptPermissions(t, compatibilityDockerfile);
  },
);

test(
  "Core-only export has no Adapter or Docker socket and verifies bootstrap and provenance",
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "openapp-core-export-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = join(root, "release");
    await run(process.execPath, ["scripts/export-openapp.mjs", "config/core.release.json", output], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const compose = await readFile(join(output, "core/docker-compose.yml"), "utf8");
    await verifyBuildScriptPermissions(t, await readFile(join(output, "core/backend/Dockerfile"), "utf8"));
    assert.doesNotMatch(compose, /docker-socket-proxy:|docker.sock|docker-control/);
    assert.match(compose, /OPENAPP_CONTROL_PLANE_ONLY: "true"/);
    const catalog = JSON.parse(await readFile(join(output, "core/plugins.json"), "utf8"));
    assert.deepEqual(catalog.plugins, []);
    const manifest = JSON.parse(await readFile(join(output, "release-manifest.json"), "utf8"));
    assert.ok(manifest.files["core/bootstrap-admin.sh"]);
    assert.ok(!Object.keys(manifest.files).some((p) => p.includes("adapter-assets/")));
    await run(process.execPath, [join(output, "verify.mjs")]);
    manifest.sourceFingerprint = "0".repeat(64);
    await writeFile(join(output, "release-manifest.json"), JSON.stringify(manifest));
    await assert.rejects(run(process.execPath, [join(output, "verify.mjs")]), /fingerprint/);
  },
);

// 执行导出 Dockerfile 的实际权限命令，覆盖空目录、无构建材料以及不可执行的脚本。
test("Docker build-script permissions work in a POSIX shell", async (t) => {
  await verifyBuildScriptPermissions(
    t,
    await readFile(new URL("../backend/deployment/bundle/backend.Dockerfile", import.meta.url), "utf8"),
  );
});

async function verifyBuildScriptPermissions(t, dockerfile) {
  // 先按 Dockerfile 规则合并续行，再截取命令，避免截断后留下孤立的反斜杠。
  const command = dockerfile.replaceAll(/\\\n/g, "").match(/RUN (chmod[^]*?)\s*&& mkdir -p \/app\/releases/);
  assert.ok(command, "export must retain the shared build-script permission step");
  const cwd = await mkdtemp(join(tmpdir(), "openapp-script-permissions-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "deployment/scripts"), { recursive: true });
  await writeFile(join(cwd, "deployment/scripts/core.sh"), "#!/bin/sh\nexit 0\n");
  const execute = () => run("/bin/sh", ["-c", command[1]], { cwd });
  await execute();
  await mkdir(join(cwd, "adapters/no-build/dist"), { recursive: true });
  await execute();
  const buildDir = join(cwd, "adapters/with-build/deployment/build");
  await mkdir(buildDir, { recursive: true });
  const script = join(buildDir, "build image.sh");
  await writeFile(script, "#!/bin/sh\nexit 0\n");
  await chmod(script, 0o644);
  await execute();
  assert.equal((await stat(script)).mode & 0o777, 0o755);
}
