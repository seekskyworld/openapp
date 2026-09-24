import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Persistence } from "./persistence/contracts.js";
import { migrateLegacy } from "./migrate-legacy.js";
import type { OciArtifactManagementPort } from "./artifact-provider.js";

test("legacy migration loads an external Adapter and initializes additively", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-legacy-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "adapter.mjs");
  await writeFile(modulePath, `export default () => ({
    manifest: {
      id: "fixture-app",
      apiVersion: "v2",
      version: "1.0.0",
      name: "Fixture App",
      description: "",
      entry: { id: "fixture", label: "Fixture", logoUrl: "/fixture.png", challenge: "none", defaultWorkspace: "personal" },
      capabilities: {},
      workload: { runtimeContract: "fixture-v1", environmentKind: "container", workloadClass: "web", accessMode: "http", healthPath: "/health" },
      compatibility: {
        migration: {
          id: "fixture-legacy-to-openapp-v1",
          fromSchema: "fixture-legacy-v1",
          toSchema: "openapp-v1",
          checksum: "sha256:${"a".repeat(64)}",
          strategy: "additive",
          preserves: ["users", "identities", "workspaces"]
        }
      }
    }
  });\n`, "utf8");

  let initializeOptions: unknown;
  const persistence = {
    async initialize(options: unknown) { initializeOptions = options; },
  } as unknown as Persistence;
  const result = await migrateLegacy({
    persistence,
    artifacts: inertArtifacts(),
    environment: {
      OPENAPP_APP_ID: "fixture-app",
      OPENAPP_ADAPTER_ID: "fixture-app",
      OPENAPP_ADAPTER_MODULE: modulePath,
      OPENAPP_ADAPTER_REQUIRED: "true",
      OPENAPP_ADAPTER_ALLOWED_ROOTS: root,
    },
  });

  assert.equal(result.appId, "fixture-app");
  assert.equal(result.persistence, "injected");
  assert.equal(result.plan?.id, "fixture-legacy-to-openapp-v1");
  assert.equal(result.plan?.strategy, "additive");
  assert.deepEqual(result.plan?.preserves, ["users", "identities", "workspaces"]);
  assert.deepEqual(initializeOptions, {
    legacyCompatibility: true,
    compatibilityDefaults: { authProvider: "none", appId: "fixture-app" },
    strategyDefinitions: [],
    provisioningPolicyDefaults: { defaultAppId: "fixture-app" },
  });
});

test("legacy migration fails closed when no external Adapter is selected", async () => {
  await assert.rejects(
    migrateLegacy({
      artifacts: inertArtifacts(),
      environment: { OPENAPP_ADAPTER_REQUIRED: "true" },
    }),
    /external_adapter_module_required/u,
  );
});

test("legacy migration rejects transform plans before touching Persistence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-legacy-transform-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modulePath = join(root, "adapter.mjs");
  await writeFile(modulePath, `export default () => ({
    manifest: {
      id: "fixture-transform",
      apiVersion: "v2",
      version: "1.0.0",
      name: "Fixture Transform",
      description: "",
      entry: { id: "fixture-transform", label: "Fixture Transform", logoUrl: "/fixture.png", challenge: "none", defaultWorkspace: "personal" },
      capabilities: {},
      workload: { runtimeContract: "fixture-transform-v1", environmentKind: "container", workloadClass: "web", accessMode: "http", healthPath: "/health" },
      compatibility: {
        migration: {
          id: "fixture-transform-migration",
          fromSchema: "fixture-legacy-v1",
          toSchema: "openapp-v1",
          checksum: "${"a".repeat(64)}",
          strategy: "transform",
          preserves: ["users"]
        }
      }
    }
  });\n`, "utf8");

  let initializeCalled = false;
  const persistence = {
    async initialize() { initializeCalled = true; },
  } as unknown as Persistence;
  await assert.rejects(
    migrateLegacy({
      persistence,
      artifacts: inertArtifacts(),
      environment: {
        OPENAPP_APP_ID: "fixture-transform",
        OPENAPP_ADAPTER_ID: "fixture-transform",
        OPENAPP_ADAPTER_MODULE: modulePath,
        OPENAPP_ADAPTER_REQUIRED: "true",
        OPENAPP_ADAPTER_ALLOWED_ROOTS: root,
      },
    }),
    /legacy_migration_strategy_unsupported/u,
  );
  assert.equal(initializeCalled, false);
});

function inertArtifacts(): OciArtifactManagementPort {
  return {
    async listImages() { return []; },
    async resolveImage() { return `sha256:${"a".repeat(64)}`; },
    async validateImage() {},
    async validateBuiltImage() {},
    async removeImageIfCurrent() { return true; },
    async pullImage() {},
    async loadImage() {},
  };
}
