import assert from "node:assert/strict";
import test from "node:test";

import { DockerProviderAdapter } from "./docker-provider-adapter.js";
import type { ContainerInstance, ContainerRuntime } from "./runtime.js";
import { createContainerRuntimeStub } from "./testing/container-runtime-stub.js";

test("Docker provider reconcile provisions once and returns no access endpoint", async () => {
  let instance: ContainerInstance | null = null;
  let provisions = 0;
  const runtime = runtimeStub({
    async get() { return instance; },
    async provision(request) {
      provisions += 1;
      instance = runtimeInstance({
        runtimeId: "docker-environment-created",
        state: request.start === false ? "stopped" : "running",
      });
      return instance;
    },
  });
  const adapter = new DockerProviderAdapter(runtime);
  const request = reconcileRequest();

  const first = await adapter.reconcile(request);
  const replay = await adapter.reconcile(request);

  assert.equal(first.status, "applied");
  assert.equal(first.execution.environmentRef, "docker-environment-created");
  assert.equal("endpoint" in first.execution, false);
  assert.equal(replay.status, "applied");
  assert.equal(provisions, 1);
});

test("Docker provider reconcile preserves stopped rebuild intent and transaction fencing", async () => {
  const rebuilds: unknown[] = [];
  const runtime = runtimeStub({
    async get() { return runtimeInstance(); },
    async rebuild(request) {
      rebuilds.push(structuredClone({ ...request, signal: undefined }));
      return runtimeInstance({ runtimeId: "docker-environment-rebuilt", state: "stopped", endpoint: null });
    },
  });
  const adapter = new DockerProviderAdapter(runtime);
  const request = {
    ...reconcileRequest(),
    replace: true,
    desiredState: "stopped" as const,
  };

  const result = await adapter.reconcile(request);

  assert.equal(result.status, "awaiting_first_start");
  assert.equal(result.execution.observedState, "stopped");
  assert.deepEqual(rebuilds, [{
    instanceId: request.workspaceId,
    ownerId: request.ownerId,
    appId: request.appId,
    appVersionId: request.appRevisionId,
    imageArtifactId: request.launchArtifactId,
    imageReference: request.launchArtifactReference,
    sourceCatalogSnapshot: request.sourceCatalogSnapshot,
    launchProfile: request.launchProfile,
    storageBindings: request.storageBindings,
    start: false,
    rebuildTransactionId: request.transactionId,
    signal: undefined,
  }]);
});

test("Docker storage resolution maps a stable WorkspaceStorageRef through the Runtime boundary", async () => {
  const requests: unknown[] = [];
  const adapter = new DockerProviderAdapter(runtimeStub({
    async resolveStorageBinding(request) {
      requests.push(structuredClone({ ...request, signal: undefined }));
      return {
        storageId: request.storageId,
        attachmentRef: "provider-volume-workspace",
        mountPath: "/var/lib/sample-app",
        readOnly: false,
      };
    },
  }));

  const binding = await adapter.resolveStorageBinding({
    workspaceId: "provider-workspace",
    ownerId: "provider-owner",
    providerId: "docker",
    storageRef: {
      id: "workspace-storage:provider-workspace",
      storageClass: "workspace-data",
      affinity: { providerId: "docker" },
    },
  });

  assert.deepEqual(binding, {
    storageId: "workspace-storage:provider-workspace",
    attachmentRef: "provider-volume-workspace",
    mountPath: "/var/lib/sample-app",
    readOnly: false,
  });
  assert.deepEqual(requests, [{
    workspaceId: "provider-workspace",
    ownerId: "provider-owner",
    storageId: "workspace-storage:provider-workspace",
    storageClass: "workspace-data",
    affinityProviderId: "docker",
    affinityRegion: undefined,
    signal: undefined,
  }]);
  await assert.rejects(adapter.resolveStorageBinding({
    workspaceId: "provider-workspace",
    ownerId: "provider-owner",
    providerId: "docker",
    storageRef: {
      id: "workspace-storage:provider-workspace",
      storageClass: "workspace-data",
      affinity: { providerId: "daytona" },
    },
  }), /provider_storage_affinity_mismatch/u);
});

test("Docker access targets are resolved independently and validate owner plus protocol", async () => {
  const runtime = runtimeStub({
    async observe() { return runtimeInstance(); },
  });
  const adapter = new DockerProviderAdapter(runtime);
  const target = await adapter.resolveAccessTarget({
    workspaceId: "provider-workspace",
    expectedOwnerId: "provider-owner",
    logicalService: "workspace_ui",
  });

  assert.equal(target.url.href, "http://127.0.0.1:37371/");
  assert.equal(target.providerId, "docker");
  assert.equal(target.environmentRef, "docker-environment");
  assert.equal(target.expiresAt, null);

  await assert.rejects(
    new DockerProviderAdapter(runtimeStub({
      async observe() { return runtimeInstance({ ownerId: "foreign-owner" }); },
    })).resolveAccessTarget({
      workspaceId: "provider-workspace",
      expectedOwnerId: "provider-owner",
      logicalService: "workspace_ui",
    }),
    /provider_environment_owner_mismatch/u,
  );
  await assert.rejects(
    new DockerProviderAdapter(runtimeStub({
      async observe() { return runtimeInstance({ endpoint: "file:///tmp/not-an-upstream" }); },
    })).resolveAccessTarget({
      workspaceId: "provider-workspace",
      expectedOwnerId: "provider-owner",
      logicalService: "workspace_ui",
    }),
    /provider_access_target_invalid/u,
  );
});

test("Docker provider forwards AbortSignal and reports unsupported optional capabilities", async () => {
  const controller = new AbortController();
  const observedSignals: AbortSignal[] = [];
  const adapter = new DockerProviderAdapter(runtimeStub({
    async get(_id, signal) {
      if (signal) observedSignals.push(signal);
      return runtimeInstance();
    },
  }));
  await adapter.reconcile({ ...reconcileRequest(), signal: controller.signal });
  assert.deepEqual(observedSignals, [controller.signal]);
  assert.deepEqual(await adapter.readMetrics("provider-workspace"), { status: "unsupported" });
  assert.deepEqual(await adapter.readDiagnostics("provider-workspace"), { status: "unsupported" });
});

test("Docker provider keeps Environment removal separate from Workspace storage release", async () => {
  const calls: unknown[] = [];
  const adapter = new DockerProviderAdapter(runtimeStub({
    async removeEnvironment(request) {
      calls.push(["environment", structuredClone({ ...request, signal: undefined })]);
    },
    async releaseWorkspaceStorage(request) {
      calls.push(["storage", structuredClone({ ...request, signal: undefined })]);
    },
  }));
  const storageRef = {
    id: "workspace-storage:provider-workspace",
    storageClass: "workspace-data",
    affinity: { providerId: "docker" },
  };

  await adapter.removeEnvironment({
    workspaceId: "provider-workspace",
    ownerId: "provider-owner",
    storageBindings: reconcileRequest().storageBindings,
  });
  await adapter.releaseWorkspaceStorage({
    workspaceId: "provider-workspace",
    ownerId: "provider-owner",
    providerId: "docker",
    storageRef,
    binding: reconcileRequest().storageBindings[0]!,
  });

  assert.deepEqual(calls, [
    ["environment", {
      instanceId: "provider-workspace",
      ownerId: "provider-owner",
      storageBindings: reconcileRequest().storageBindings,
      signal: undefined,
    }],
    ["storage", {
      instanceId: "provider-workspace",
      ownerId: "provider-owner",
      storageBindings: reconcileRequest().storageBindings,
      signal: undefined,
    }],
  ]);
  await assert.rejects(adapter.releaseWorkspaceStorage({
    workspaceId: "provider-workspace",
    ownerId: "provider-owner",
    providerId: "docker",
    storageRef,
    binding: { ...reconcileRequest().storageBindings[0]!, storageId: "workspace-storage:foreign" },
  }), /provider_storage_release_identity_mismatch/u);
});

function runtimeStub(overrides: Partial<ContainerRuntime>): ContainerRuntime {
  return createContainerRuntimeStub(overrides);
}

function reconcileRequest() {
  return {
    workspaceId: "provider-workspace",
    ownerId: "provider-owner",
    appId: "sample-app",
    appRevisionId: "provider-release",
    launchArtifactId: "provider-artifact",
    launchArtifactReference: "sha256:provider-artifact",
    sourceCatalogSnapshot: {
      appId: "sample-app",
      appVersionId: "provider-source-release",
      imageArtifactId: "provider-source-artifact",
      imageReference: "sha256:provider-source",
    },
    launchProfile: {
      imageReference: "sha256:provider-artifact",
      resources: { memory: "2g", cpus: "1", pidsLimit: 256 },
      environment: {},
      configFiles: [],
    },
    storageBindings: [{
      storageId: "workspace-storage:provider-workspace",
      attachmentRef: "test-data-provider-workspace",
      mountPath: "/var/lib/sample-app",
      readOnly: false,
    }],
    desiredState: "running" as const,
    desiredGeneration: 2,
    transactionId: "provider-transaction",
    replace: false,
  };
}

function runtimeInstance(overrides: Partial<ContainerInstance> = {}): ContainerInstance {
  return {
    instanceId: "provider-workspace",
    ownerId: "provider-owner",
    runtimeId: "docker-environment",
    state: "running",
    endpoint: "http://127.0.0.1:37371",
    createdAt: "2026-08-04T00:00:00.000Z",
    ...overrides,
  };
}
