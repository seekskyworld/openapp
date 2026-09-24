import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { validateAdapterManifest as validatePublicAdapterManifest } from "../packages/contracts/dist/index.js";
import { validateAdapterManifest } from "./validate-adapter-manifest.mjs";

const execFileAsync = promisify(execFile);

test("prints only the non-sensitive manifest identity for composition locking", async (t) => {
  const root = await createAdapter();
  t.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    "scripts/validate-adapter-manifest.mjs",
    "--adapter-root", root,
    "--app-id", "demo",
    "--adapter-id", "demo",
    "--print-identity",
  ], { cwd: process.cwd() });
  assert.deepEqual(JSON.parse(stdout), {
    apiVersion: "v2",
    id: "demo",
    version: "1.0.0",
    runtimeContract: "demo-v1",
  });
});

async function createAdapter(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "openapp-adapter-manifest-"));
  const manifest = options.manifest ?? minimalManifest();
  await mkdir(join(root, "dist"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "demo-adapter",
    version: options.packageVersion ?? "1.0.0",
    type: "module",
  }));
  await writeFile(join(root, "dist/index.js"), `export default () => ({ manifest: ${JSON.stringify(manifest)} });\n`);
  if (options.runtimeProfile) {
    await mkdir(join(root, "runtime"), { recursive: true });
    await writeFile(join(root, "runtime/profile.json"), JSON.stringify(options.runtimeProfile));
  }
  if (options.migrationPlan !== undefined) {
    const migrationPath = join(root, "deployment", "legacy");
    await mkdir(migrationPath, { recursive: true });
    await writeFile(join(migrationPath, "migration-plan.json"), options.migrationPlan);
  }
  return root;
}

function minimalManifest() {
  return {
    id: "demo",
    apiVersion: "v2",
    version: "1.0.0",
    name: "Demo",
    description: "",
    entry: { id: "demo", label: "Demo", logoUrl: "https://example.test/logo.png", challenge: "none", defaultWorkspace: "personal" },
    capabilities: {},
    workload: { runtimeContract: "demo-v1", environmentKind: "container", workloadClass: "web", accessMode: "http", healthPath: "/health" },
  };
}

function runtimeProfile(contract) {
  return {
    id: "demo-runtime",
    contract,
    labelPrefix: "io.example.demo",
    storageClass: "workspace-data",
    storageMountPath: "/var/lib/demo",
    containerPort: 8080,
    containerUser: "demo",
    entrypoint: "/opt/demo/start.sh",
    command: ["serve"],
    recoveryCommand: ["node", "/opt/demo/recover.mjs"],
    configEnvironmentKey: "DEMO_CONFIG",
    lockRecoveryEnvironment: {
      containers: "DEMO_RECOVER_CONTAINERS",
      hosts: "DEMO_RECOVER_HOSTS",
      recoveryId: "DEMO_RECOVERY_ID",
    },
    reservedEnvironment: ["DEMO_CONFIG"],
    healthPath: "/health",
  };
}

test("runtime recovery is optional and incomplete or old declarations fail closed", () => {
  const manifest = minimalManifest();
  const profile = runtimeProfile("demo-v1");
  const { recoveryCommand, lockRecoveryEnvironment, ...withoutRecovery } = profile;
  manifest.workload.runtime = withoutRecovery;
  assert.equal(validatePublicAdapterManifest(manifest).workload.runtime.recoveryCommand, undefined);
  manifest.workload.runtime = { ...withoutRecovery, recoveryCommand };
  assert.throws(() => validatePublicAdapterManifest(manifest), /runtime_lock_environment_invalid/);
  manifest.workload.runtime = { ...withoutRecovery, recoveryScript: "/old.mjs" };
  assert.throws(() => validatePublicAdapterManifest(manifest), /runtime_recovery_command_required/);
  manifest.workload.runtime = { ...withoutRecovery, recoveryCommand: ["/bin/recover"], lockRecoveryEnvironment };
  assert.deepEqual(validatePublicAdapterManifest(manifest).workload.runtime.recoveryCommand, ["/bin/recover"]);
});

test("composition rejects recovery capabilities absent from the manifest", async (t) => {
  const profile = runtimeProfile("demo-v1");
  const { recoveryCommand, lockRecoveryEnvironment, ...withoutRecovery } = profile;
  const manifest = minimalManifest();
  manifest.workload.runtime = withoutRecovery;
  const root = await createAdapter({ manifest, runtimeProfile: { ...profile, appId: "demo" } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(validateAdapterManifest({ adapterRoot: root, appId: "demo", adapterId: "demo" }), /recoveryCommand does not match/);
});

test("validates a minimal generic Adapter without product dependencies", async (t) => {
  const root = await createAdapter();
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = await validateAdapterManifest({ adapterRoot: root, appId: "demo", adapterId: "demo" });
  assert.equal(result.manifest.id, "demo");
});

test("binds a declared migration checksum to the Adapter descriptor bytes", async (t) => {
  const descriptor = `${JSON.stringify({
    id: "demo-legacy-to-v1",
    fromSchema: "demo-legacy-v1",
    toSchema: "openapp-v1",
    strategy: "additive",
  })}\n`;
  const checksum = createHash("sha256").update(descriptor).digest("hex");
  const manifest = {
    ...minimalManifest(),
    compatibility: {
      migration: {
        id: "demo-legacy-to-v1",
        fromSchema: "demo-legacy-v1",
        toSchema: "openapp-v1",
        checksum: `sha256:${checksum}`,
        strategy: "additive",
      },
    },
  };
  const matching = await createAdapter({ manifest, migrationPlan: descriptor });
  t.after(() => rm(matching, { recursive: true, force: true }));
  await assert.doesNotReject(validateAdapterManifest({ adapterRoot: matching, appId: "demo" }));

  const tampered = await createAdapter({
    manifest,
    migrationPlan: `${descriptor}tampered`,
  });
  t.after(() => rm(tampered, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterManifest({ adapterRoot: tampered, appId: "demo" }),
    /migration plan checksum does not match/u,
  );

  const missing = await createAdapter({ manifest });
  t.after(() => rm(missing, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterManifest({ adapterRoot: missing, appId: "demo" }),
    /Adapter migration plan is missing/u,
  );
});

test("accepts a bare SHA-256 migration checksum", async (t) => {
  const descriptor = `${JSON.stringify({
    id: "demo-legacy-to-v1",
    fromSchema: "demo-legacy-v1",
    toSchema: "openapp-v1",
    strategy: "additive",
  })}\n`;
  const checksum = createHash("sha256").update(descriptor).digest("hex");
  const root = await createAdapter({
    migrationPlan: descriptor,
    manifest: {
      ...minimalManifest(),
      compatibility: {
        migration: {
          id: "demo-legacy-to-v1",
          fromSchema: "demo-legacy-v1",
          toSchema: "openapp-v1",
          checksum,
          strategy: "additive",
        },
      },
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.doesNotReject(validateAdapterManifest({ adapterRoot: root, appId: "demo" }));
});

test("public contract rejects cross-field authentication and Runtime mismatches", () => {
  const manifest = minimalManifest();
  assert.throws(
    () => validatePublicAdapterManifest({
      ...manifest,
      entry: { ...manifest.entry, challenge: "email_code" },
    }),
    /adapter_manifest_auth_challenge_mismatch/u,
  );
  assert.throws(
    () => validatePublicAdapterManifest({
      ...manifest,
      workload: { ...manifest.workload, runtime: runtimeProfile("other-v1") },
    }),
    /adapter_manifest_runtime_contract_mismatch/u,
  );
  assert.throws(
    () => validatePublicAdapterManifest({
      ...manifest,
      build: {
        strategyId: "demo-build",
        revision: 1,
        runtimeContract: "other-v1",
        packageRequirements: [{ key: "bundle", required: true, acceptedExtensions: [".zip"] }],
        imagePrefix: "demo",
      },
    }),
    /adapter_manifest_build_runtime_mismatch/u,
  );
  assert.throws(
    () => validatePublicAdapterManifest({
      ...manifest,
      catalogBootstrap: {
        version: "1.0.0",
        imageReference: "demo-runtime:1.0.0",
        runtimeContract: "other-v1",
      },
    }),
    /adapter_manifest_bootstrap_runtime_mismatch/u,
  );
});

test("rejects invalid manifests before they reach the Portal", async (t) => {
  const root = await createAdapter({
    manifest: {
      id: "demo",
      apiVersion: "v2",
      version: "1.0.0",
      name: "Demo",
      description: "",
      entry: { id: "demo", label: "Demo", logoUrl: "javascript:bad", challenge: "none", defaultWorkspace: "personal" },
      capabilities: {},
      workload: { runtimeContract: "demo-v1", environmentKind: "container", workloadClass: "web", accessMode: "http", healthPath: "/health" },
    },
  });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(validateAdapterManifest({ adapterRoot: root, appId: "demo" }), /manifest contract is invalid/u);
});

test("rejects a package whose version is not the manifest version", async (t) => {
  const root = await createAdapter({ packageVersion: "2.0.0" });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterManifest({ adapterRoot: root, appId: "demo" }),
    /package version does not match manifest version/u,
  );
});

test("checks Runtime metadata against the Adapter manifest", async (t) => {
  const missing = await createAdapter({ runtimeProfile: { runtimeContract: "demo-v1" } });
  t.after(() => rm(missing, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterManifest({ adapterRoot: missing, appId: "demo" }),
    /profile appId is required/u,
  );

  const root = await createAdapter({ runtimeProfile: { appId: "other", runtimeContract: "demo-v1" } });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(validateAdapterManifest({ adapterRoot: root, appId: "demo" }), /Runtime profile appId/u);

  const mismatch = await createAdapter({ runtimeProfile: { appId: "demo", runtimeContract: "other-v1" } });
  t.after(() => rm(mismatch, { recursive: true, force: true }));
  await assert.rejects(validateAdapterManifest({ adapterRoot: mismatch, appId: "demo" }), /profile contract does not match/u);
});

test("rejects Runtime field drift and legacy manifests from another App", async (t) => {
  const manifest = {
    ...minimalManifest(),
    workload: { ...minimalManifest().workload, runtime: runtimeProfile("demo-v1") },
  };
  const runtime = {
    ...runtimeProfile("demo-v1"),
    appId: "demo",
    environmentKind: "container",
    workloadClass: "web",
    accessMode: "http",
    healthPath: "/health",
    labelPrefix: "io.example.other",
  };
  const root = await createAdapter({ manifest, runtimeProfile: runtime });
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterManifest({ adapterRoot: root, appId: "demo" }),
    /profile labelPrefix does not match manifest runtime/u,
  );

  const legacyRoot = join(root, "deployment", "legacy");
  await mkdir(legacyRoot, { recursive: true });
  await writeFile(join(legacyRoot, "manifest.json"), JSON.stringify({
    appId: "other",
    adapterId: "other",
    version: "1.0.0",
  }));
  const cleanRoot = await createAdapter();
  t.after(() => rm(cleanRoot, { recursive: true, force: true }));
  const cleanLegacyRoot = join(cleanRoot, "deployment", "legacy");
  await mkdir(cleanLegacyRoot, { recursive: true });
  await writeFile(join(cleanLegacyRoot, "manifest.json"), JSON.stringify({
    appId: "other",
    adapterId: "other",
    version: "1.0.0",
  }));
  await assert.rejects(
    validateAdapterManifest({ adapterRoot: cleanRoot, appId: "demo" }),
    /legacy manifest appId does not match/u,
  );
});

test("rejects an Adapter module without a factory", async (t) => {
  const root = await createAdapter();
  await writeFile(join(root, "dist/index.js"), "export const value = 1;\n");
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(validateAdapterManifest({ adapterRoot: root, appId: "demo" }), /does not export an adapter factory/u);
});
