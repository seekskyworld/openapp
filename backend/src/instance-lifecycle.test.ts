import assert from "node:assert/strict";
import test from "node:test";

import { InstanceLifecycle, type LifecycleStore } from "./instance-lifecycle.js";
import { MemoryPersistence } from "./persistence/memory.js";
import type { Container } from "./models.js";
import type { ContainerInstance, ContainerRuntime } from "./runtime.js";

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
