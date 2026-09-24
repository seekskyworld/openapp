import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import {
  COMPOSITION_LOCK_FILE,
  createCompositionLock,
  verifyCompositionLock,
} from "./composition-lock.mjs";

const execFileAsync = promisify(execFile);

test("composition lock records and verifies a complete generic bundle", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const options = fixtureOptions(root);
  const lock = await createCompositionLock(options);
  assert.equal(lock.schemaVersion, 3);
  assert.equal(lock.app.id, "demo");
  assert.deepEqual(lock.adapter.manifest, {
    apiVersion: "v2",
    id: "demo",
    version: "1.2.3",
    runtimeContract: "generic-v1",
  });
  assert.match(lock.app.files[0].sha256, /^[a-f0-9]{64}$/u);
  assert.equal(lock.runtime.contract, "generic-v1");
  assert.equal((await readFile(join(root, COMPOSITION_LOCK_FILE), "utf8")).endsWith("\n"), true);
  const result = await verifyCompositionLock(options);
  assert.equal(result.skipped, false);
});

test("composition lock rejects replacement of an App package", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = fixtureOptions(root);
  await createCompositionLock(options);
  await writeFile(join(root, "demo/backend/demo-1.0.0.tgz"), "tampered");
  await assert.rejects(verifyCompositionLock(options), /app\.files/u);
});

test("composition lock rejects Adapter and Runtime drift", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = fixtureOptions(root);
  await createCompositionLock(options);
  await writeFile(join(root, "adapters/demo/dist/index.js"), "changed");
  await assert.rejects(verifyCompositionLock(options), /adapter\.digest/u);

  await writeFile(join(root, "adapters/demo/dist/index.js"), "adapter\n");
  const lockPath = join(root, COMPOSITION_LOCK_FILE);
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.adapter.manifest.version = "9.9.9";
  await writeFile(lockPath, `${JSON.stringify(lock)}\n`);
  await assert.rejects(verifyCompositionLock(options), /adapter\.manifest/u);

  await createCompositionLock(options);
  await writeFile(join(root, "runtime/profile.json"), JSON.stringify({
    appId: "demo",
    runtimeContract: "other-v1",
    environmentKind: "container",
    workloadClass: "web",
    accessMode: "http",
    healthPath: "/api/health",
  }));
  await assert.rejects(verifyCompositionLock(options), /runtime contract/u);
});

test("missing composition lock is only allowed by an explicit legacy flag", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = fixtureOptions(root);
  await assert.rejects(verifyCompositionLock(options), /composition lock is missing/u);
  const result = await verifyCompositionLock({ ...options, allowLegacy: true });
  assert.deepEqual(result, { skipped: true, reason: "composition_lock_missing" });
});

test("generic composition locking requires the validated Adapter manifest identity", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await rm(join(root, "adapters/demo/manifest.json"));
  await assert.rejects(
    createCompositionLock(fixtureOptions(root)),
    /requires Adapter manifest identity/u,
  );
});

test("composition lock requires and verifies an external Adapter Runtime identity", async (t) => {
  const root = await createFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapterRuntime = join(root, "adapters/demo/runtime");
  await mkdir(adapterRuntime, { recursive: true });
  await writeFile(join(adapterRuntime, "profile.json"), JSON.stringify({
    runtimeContract: "generic-v1",
    contextFiles: ["start.sh"],
  }));
  await assert.rejects(
    createCompositionLock(fixtureOptions(root)),
    /requires Adapter Runtime profile appId/u,
  );

  await writeFile(join(adapterRuntime, "profile.json"), JSON.stringify({
    appId: "other",
    runtimeContract: "generic-v1",
    contextFiles: ["start.sh"],
  }));
  await assert.rejects(
    createCompositionLock(fixtureOptions(root)),
    /does not match Adapter slot/u,
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "openapp-composition-lock-"));
  await Promise.all([
    mkdir(join(root, "backend/dist"), { recursive: true }),
    mkdir(join(root, "backend/runtime/dist"), { recursive: true }),
    mkdir(join(root, "packages/contracts"), { recursive: true }),
    mkdir(join(root, "adapters/demo/dist"), { recursive: true }),
    mkdir(join(root, "runtime"), { recursive: true }),
    mkdir(join(root, "demo/backend"), { recursive: true }),
    mkdir(join(root, "demo/frontend"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "backend/dist/index.js"), "core\n"),
    writeFile(join(root, "backend/runtime/dist/index.js"), "runtime\n"),
    writeFile(join(root, "backend/package.json"), "{}\n"),
    writeFile(join(root, "backend/package-lock.json"), "{}\n"),
    writeFile(join(root, "packages/contracts/package.json"), JSON.stringify({ version: "0.1.0" })),
    writeFile(join(root, "packages/contracts/index.js"), "contracts\n"),
    writeFile(join(root, "adapters/demo/package.json"), JSON.stringify({ version: "1.2.3" })),
    writeFile(join(root, "adapters/demo/dist/index.js"), "adapter\n"),
    writeFile(join(root, "adapters/demo/manifest.json"), JSON.stringify({
      apiVersion: "v2",
      id: "demo",
      version: "1.2.3",
      runtimeContract: "generic-v1",
    })),
    writeFile(join(root, "runtime/Dockerfile"), "FROM scratch\n"),
    writeFile(join(root, "runtime/start.sh"), "#!/bin/sh\n"),
    writeFile(join(root, "runtime/profile.json"), JSON.stringify({
      appId: "demo",
      runtimeContract: "generic-v1",
      environmentKind: "container",
      workloadClass: "web",
      accessMode: "http",
      healthPath: "/api/health",
    })),
    writeFile(join(root, ".env.example"), "OPENAPP_APP_ID=demo\nOPENAPP_ADAPTER_ID=demo\nOPENAPP_RELEASE_PATH=demo\n"),
  ]);
  const packageRoot = join(root, "package-fixture/package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0" }));
  await execFileAsync("tar", ["-czf", join(root, "demo/backend/demo-1.0.0.tgz"), "-C", join(root, "package-fixture"), "package"]);
  await execFileAsync("tar", ["-czf", join(root, "demo/frontend/demo-web-1.0.0.tar.gz"), "-C", root, "runtime/start.sh"]);
  await chmod(join(root, "runtime/start.sh"), 0o755);
  return root;
}

function fixtureOptions(root) {
  return {
    root,
    appId: "demo",
    adapterId: "demo",
    releasePath: "demo",
    runtimeImage: "demo-runtime:fixture",
    targetPlatform: "linux/amd64",
    sourceFingerprint: "a".repeat(64),
    coreRevision: "core-revision",
    adapterRevision: "adapter-revision",
  };
}
