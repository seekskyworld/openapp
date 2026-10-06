import assert from "node:assert/strict";
import test from "node:test";

import { InstanceLifecycle, type LifecycleStore } from "./instance-lifecycle.js";
import { MemoryPersistence } from "./persistence/memory.js";
import type { Container } from "./models.js";
import type { ContainerInstance, ContainerRuntime } from "./runtime.js";
import { ContainerRebuildRollbackError } from "./runtime.js";
import { isRuntimeCatalogSnapshotValid } from "./runtime-catalog.js";
import { genericProvisioningPolicy } from "./instance-policy.js";

test("target rebuild does not persist a deferred candidate snapshot before cutover", async () => {
  const persistence = new MemoryPersistence();
  const source: Container = {
    id: "deferred-candidate-instance",
    userId: "deferred-candidate-owner",
    appId: "sample-app",
    runtimeId: "source-runtime",
    status: "stopped",
    endpoint: null,
    stopReason: "manual_user",
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    lastActivityAt: "2026-09-24T00:00:00.000Z",
    appVersionId: "source-version",
    imageArtifactId: "source-artifact",
    imageReference: "sha256:source",
  };
  await persistence.saveContainer(source);

  let getCalls = 0;
  let rebuildRequest: Parameters<NonNullable<ContainerRuntime["rebuild"]>>[0] | undefined;
  const runtime: ContainerRuntime = {
    async provision() {
      throw new Error("unused");
    },
    async get() {
      getCalls += 1;
      return runtimeInstance({
        runtimeId: "deferred-candidate-runtime",
        state: "stopped",
        catalogSnapshot: {
          appId: "sample-app",
          appVersionId: "stale-candidate-version",
          imageArtifactId: "stale-candidate-artifact",
          imageReference: "sha256:stale-candidate",
        },
      });
    },
    async start() {
      throw new Error("unused");
    },
    async stop() {
      throw new Error("unused");
    },
    async rebuild(request) {
      rebuildRequest = request;
      return runtimeInstance({
        runtimeId: "target-runtime",
        state: "stopped",
        catalogSnapshot: {
          appId: "sample-app",
          appVersionId: "target-version",
          imageArtifactId: "target-artifact",
          imageReference: "sha256:target",
        },
      });
    },
    async sampleActivity() {
      throw new Error("unused");
    },
    async remove() {
      throw new Error("unused");
    },
  };
  const lifecycle = new InstanceLifecycle({
    store: persistence as unknown as LifecycleStore,
    runtime,
  });

  const updated = await lifecycle.rebuild(source.id, null, {
    target: {
      appVersionId: "target-version",
      imageArtifactId: "target-artifact",
      imageReference: "sha256:target",
      launchProfile: {
        imageReference: "sha256:target",
        resources: { memory: "1g", cpus: "1", pidsLimit: 128 },
        environment: {},
        configFiles: [],
      },
    },
    targetState: "stopped",
  });

  assert.equal(getCalls, 0);
  assert.equal(rebuildRequest?.imageArtifactId, "target-artifact");
  assert.equal(updated.imageArtifactId, "target-artifact");
  assert.equal((await persistence.getContainer(source.id))?.imageArtifactId, "target-artifact");
});

function runtimeInstance(overrides: Partial<ContainerInstance>): ContainerInstance {
  return {
    instanceId: "deferred-candidate-instance",
    ownerId: "deferred-candidate-owner",
    runtimeId: "runtime",
    state: "stopped",
    endpoint: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
}

async function catalogFixture() {
  const persistence = new MemoryPersistence();
  await persistence.saveProvisioningPolicy(genericProvisioningPolicy("sample-app", {}));
  const source: Container = {
    id: "deferred-candidate-instance", userId: "deferred-candidate-owner", appId: "sample-app",
    runtimeId: "source-runtime", status: "stopped", endpoint: null, stopReason: "idle",
    createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    lastActivityAt: "2026-09-24T00:00:00.000Z", appVersionId: null,
    imageArtifactId: null, imageReference: "sha256:source",
  };
  await persistence.saveContainer(source);
  const snapshot = { appId: source.appId, appVersionId: null, imageArtifactId: null, imageReference: source.imageReference! };
  let observed = runtimeInstance({ catalogSnapshot: snapshot });
  let starts = 0;
  const runtime: ContainerRuntime = {
    provision: async () => { throw new Error("unused"); },
    get: async () => observed,
    observe: async () => observed,
    start: async () => { starts++; return { ...observed, state: "running", endpoint: "http://instance:3000" }; },
    stop: async () => observed,
    remove: async () => {},
    sampleActivity: async () => { throw new Error("unused"); },
  };
  const store = persistence as unknown as LifecycleStore;
  store.isCatalogSnapshotValid = (value) => isRuntimeCatalogSnapshotValid(value, persistence, {
    getArtifact: (id) => persistence.getImageArtifact(id),
  });
  return { persistence, source, snapshot, runtime, store,
    lifecycle: new InstanceLifecycle({ store, runtime }),
    observe: (value: ContainerInstance) => { observed = value; },
    starts: () => starts,
  };
}

for (const missing of ["artifact", "version"] as const) {
  test(`start, sync and read reject a missing ${missing} before writing runtime labels`, async () => {
    const f = await catalogFixture();
    f.observe(runtimeInstance({ catalogSnapshot: { ...f.snapshot,
      ...(missing === "artifact" ? { imageArtifactId: "deleted-artifact" } : { appVersionId: "deleted-version" }),
    } }));
    for (const operation of ["start", "sync", "read"] as const) {
      await assert.rejects(f.lifecycle[operation](f.source.id), { code: "container_catalog_mismatch" });
      assert.deepEqual(await f.persistence.getContainer(f.source.id), f.source);
    }
    assert.equal(f.starts(), 0);
    f.observe(runtimeInstance({ catalogSnapshot: f.snapshot }));
    assert.equal((await f.lifecycle.start(f.source.id)).status, "running");
    assert.equal(f.starts(), 1);
  });
}

test("failed target rebuild preserves a valid source rollback", async () => {
  const f = await catalogFixture();
  const failure = new ContainerRebuildRollbackError(new Error("target_unhealthy"), runtimeInstance({
    runtimeId: f.source.runtimeId, state: "stopped", rebuildRecovered: true, catalogSnapshot: f.snapshot,
  }));
  f.runtime.rebuild = async () => { throw failure; };
  await assert.rejects(f.lifecycle.rebuild(f.source.id, null, { target: {
    appVersionId: null, imageArtifactId: null, imageReference: "sha256:target",
    launchProfile: { imageReference: "sha256:target", resources: { memory: "1g", cpus: "1", pidsLimit: 128 }, environment: {}, configFiles: [] },
  }, targetState: "stopped" }), /target_unhealthy/);
  const saved = await f.persistence.getContainer(f.source.id);
  assert.equal(saved?.status, "stopped");
  assert.equal(saved?.imageReference, f.source.imageReference);
});

test("rebuild validates its pinned catalog before invoking Docker", async () => {
  const f = await catalogFixture();
  let rebuilt = false;
  f.runtime.rebuild = async () => { rebuilt = true; throw new Error("unused"); };
  await assert.rejects(f.lifecycle.rebuild(f.source.id, null, { target: {
    appVersionId: "missing-version", imageArtifactId: "missing-artifact", imageReference: "sha256:target",
    launchProfile: { imageReference: "sha256:target", resources: { memory: "1g", cpus: "1", pidsLimit: 128 }, environment: {}, configFiles: [] },
  } }), { code: "container_catalog_mismatch" });
  assert.equal(rebuilt, false);
  assert.deepEqual(await f.persistence.getContainer(f.source.id), f.source);
});

test("a successful stopped rebuild clears a previous failed observation", async () => {
  const f = await catalogFixture();
  await f.persistence.updateContainer({ ...f.source, status: "failed", stopReason: "failure" });
  f.runtime.rebuild = async () => runtimeInstance({ runtimeId: "repaired-runtime", catalogSnapshot: f.snapshot });
  const result = await f.lifecycle.rebuild(f.source.id, null, { targetState: "stopped" });
  assert.equal(result.status, "stopped");
  assert.equal((await f.persistence.getContainer(f.source.id))?.status, "stopped");
  assert.equal(result.runtimeId, "repaired-runtime");
});
