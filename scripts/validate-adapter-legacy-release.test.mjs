import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateAdapterLegacyRelease } from "./validate-adapter-legacy-release.mjs";

const FILES = Object.freeze({
  compose: "docker-compose.yml",
  localCompose: "docker-compose.local.yml",
  backendDockerfile: "backend.Dockerfile",
  deploy: "deploy.sh",
  preflight: "preflight.sh",
  composeSelector: "compose-files.sh",
  fingerprint: "deployment-source-fingerprint.mjs",
  compositionLock: "composition-lock.mjs",
  runtimeDockerfile: "runtime/Dockerfile",
  runtimeStart: "runtime/start.sh",
  runtimeRecovery: "runtime/recover-state-locks.mjs",
  buildRuntime: "scripts/build-sample-image.sh",
  verifyRuntime: "scripts/verify-runtime.sh",
  legacySeed: "sample-legacy-seed.sql",
  migrationPlan: "migration-plan.json",
  exportBundle: "export-bundle.mjs",
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "openapp-adapter-legacy-release-"));
  const release = join(root, "deployment", "legacy");
  await mkdir(join(release, "runtime"), { recursive: true });
  await mkdir(join(release, "scripts"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@openapp/test-adapter", version: "1.2.3" }));
  await writeFile(join(release, "README.md"), "legacy release\n");
  await writeFile(join(release, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    appId: "demo",
    adapterId: "demo",
    version: "1.2.3",
    files: FILES,
  }));
  await Promise.all(Object.values(FILES).map(async (path) => {
    const absolute = join(release, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, `fixture:${path}\n`);
  }));
  return { root, release };
}

test("validates a complete Adapter legacy release and returns stable paths", async (t) => {
  const { root } = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await validateAdapterLegacyRelease({ adapterRoot: root, appId: "demo", adapterId: "demo" });
  assert.equal(result.version, "1.2.3");
  assert.deepEqual(Object.keys(result.files), Object.keys(FILES));
  assert.match(await readFile(result.files.runtimeRecovery, "utf8"), /fixture:runtime/u);
});

test("rejects mismatched identity, version, missing and unregistered inputs", async (t) => {
  const { root, release } = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterLegacyRelease({ adapterRoot: root, appId: "other", adapterId: "demo" }),
    /does not match requested app/u,
  );
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  await assert.rejects(validateAdapterLegacyRelease({ adapterRoot: root }), /does not match Adapter package version/u);
  await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  await rm(join(release, FILES.compose));
  await assert.rejects(validateAdapterLegacyRelease({ adapterRoot: root }), /compose is missing/u);
  await writeFile(join(release, FILES.compose), "restored\n");
  await writeFile(join(release, "unregistered.txt"), "nope\n");
  await assert.rejects(validateAdapterLegacyRelease({ adapterRoot: root }), /unregistered files/u);
});

test("rejects traversal and symlink paths", async (t) => {
  const { root, release } = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(release, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.compose = "../outside.yml";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(validateAdapterLegacyRelease({ adapterRoot: root }), /path is unsafe/u);

  manifest.files.compose = FILES.compose;
  await writeFile(manifestPath, JSON.stringify(manifest));
  const outside = join(root, "outside.yml");
  await writeFile(outside, "outside\n");
  await rm(join(release, FILES.compose));
  await symlink(outside, join(release, FILES.compose));
  await assert.rejects(validateAdapterLegacyRelease({ adapterRoot: root }), /regular file/u);
});
