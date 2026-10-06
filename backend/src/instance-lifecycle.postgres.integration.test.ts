import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { InstanceLifecycle, type LifecycleStore } from "./instance-lifecycle.js";
import { genericProvisioningPolicy } from "./instance-policy.js";
import { PostgresPersistence } from "./persistence/postgres.js";
import { isRuntimeCatalogSnapshotValid } from "./runtime-catalog.js";
import type { Container } from "./models.js";
import type { ContainerInstance, ContainerRuntime } from "./runtime.js";

const databaseUrl = process.env.POSTGRES_TEST_URL?.trim();
test("missing Docker catalog labels never reach the PostgreSQL FK and startup works after exact catalog recovery", {
  skip: databaseUrl ? false : "POSTGRES_TEST_URL is required",
}, async (t) => {
  const bootstrap = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const schema = `catalog_recovery_${randomUUID().replaceAll("-", "")}`;
  await bootstrap.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl!);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  const persistence = new PostgresPersistence(url.toString());
  t.after(async () => {
    await persistence.pool.end();
    await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
    await bootstrap.end();
  });
  await persistence.initialize();
  await persistence.saveProvisioningPolicy(genericProvisioningPolicy("sample", {}));
  const owner = await persistence.findOrCreateUser("recovery@example.test");
  const now = new Date().toISOString();
  const source: Container = {
    id: "workspace", userId: owner.id, appId: "sample", runtimeId: "old-runtime",
    appVersionId: null, imageArtifactId: null, imageReference: "sha256:old",
    status: "stopped", endpoint: null, stopReason: "idle", createdAt: now, updatedAt: now, lastActivityAt: now,
  };
  await persistence.saveContainer(source);
  const snapshot = { appId: "sample", appVersionId: "lost-version", imageArtifactId: "lost-artifact", imageReference: "sha256:existing" };
  const instance: ContainerInstance = {
    instanceId: source.id, ownerId: owner.id, runtimeId: "actual-runtime", state: "stopped",
    endpoint: null, createdAt: now, catalogSnapshot: snapshot,
  };
  let starts = 0;
  const runtime: ContainerRuntime = {
    provision: async () => { throw new Error("unused"); }, get: async () => instance, observe: async () => instance,
    start: async () => { starts++; return { ...instance, state: "running", endpoint: "http://workspace:3000" }; },
    stop: async () => instance, remove: async () => {}, sampleActivity: async () => { throw new Error("unused"); },
  };
  const store = persistence as unknown as LifecycleStore;
  store.isCatalogSnapshotValid = (value) => isRuntimeCatalogSnapshotValid(value, persistence, {
    getArtifact: (id) => persistence.getImageArtifact(id),
  });
  const lifecycle = new InstanceLifecycle({ runtime, store });
  await assert.rejects(persistence.updateContainer({ ...source, imageArtifactId: snapshot.imageArtifactId }), { code: "23503" });
  for (const operation of ["read", "sync", "start"] as const) {
    await assert.rejects(lifecycle[operation](source.id), { code: "container_catalog_mismatch" });
  }
  assert.equal(starts, 0);
  assert.equal((await persistence.getContainer(source.id))?.runtimeId, "old-runtime");
  await persistence.pool.query(`
    INSERT INTO apps(id,name) VALUES ('sample','Sample');
    INSERT INTO build_strategies(id,name) VALUES ('sample','Sample');
    INSERT INTO image_builds(id,strategy_id,strategy_snapshot,requested_by,status)
      VALUES ('lost-build','sample','{}','recovery','succeeded');
    INSERT INTO image_artifacts(id,build_id,image_reference,image_id)
      VALUES ('lost-artifact','lost-build','sample:existing','sha256:existing');
    INSERT INTO app_versions(id,app_id,revision,version,build_id,status,image_artifact_id,image_reference)
      VALUES ('lost-version','sample',1,'1.0.0','lost-build','archived','lost-artifact','sha256:existing');
  `);
  assert.equal((await lifecycle.start(source.id)).status, "running");
  assert.equal(starts, 1);
  const saved = await persistence.getContainer(source.id);
  assert.equal(saved?.runtimeId, instance.runtimeId);
  assert.equal(saved?.imageArtifactId, snapshot.imageArtifactId);
});
