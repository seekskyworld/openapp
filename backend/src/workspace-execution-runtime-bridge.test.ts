import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExecutionControlPort,
  ExecutionObservationRequest,
  ExecutionReconcileRequest,
  ExecutionReconcileResult,
  ProviderExecution,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort,
} from "./execution-provider.js";
import type { Container } from "./models.js";
import { MemoryPersistence } from "./persistence/memory.js";
import type {
  ContainerLaunchProfile,
} from "./runtime.js";
import { WorkspaceExecutionManager } from "./workspace-execution-manager.js";
import { WorkspaceExecutionRuntimeBridge } from "./workspace-execution-runtime-bridge.js";

test("the lifecycle bridge persists provision intent before exposing a running Workspace", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container({
    runtimeId: "pending",
    status: "creating",
    endpoint: null,
  }));
  const provider = new FakeProvider();
  const bridge = createBridge(persistence, provider);

  const instance = await bridge.provision({
    instanceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    appId: "sample-app",
    appVersionId: "revision-source",
    imageArtifactId: "artifact-source",
    imageReference: "sha256:source",
    launchProfile: launchProfile("sha256:source"),
  });

  assert.equal(instance.state, "running");
  assert.equal(instance.endpoint, null);
  assert.equal(provider.requests.length, 1);
  assert.equal(provider.requests[0]?.desiredGeneration, 1);
  assert.equal(provider.requests[0]?.replace, false);
  const projection = await persistence.getWorkspaceExecutionProjection(WORKSPACE_ID);
  assert.equal(projection?.execution.transactionStatus, "applied");
  assert.equal(projection?.execution.environmentRef, ENVIRONMENT_ID);
  assert.equal(projection?.execution.healthyGeneration, 1);
});

test("the lifecycle bridge fails closed when a legacy caller omits the App id", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container({
    runtimeId: "pending",
    status: "creating",
    endpoint: null,
  }));
  const bridge = createBridge(persistence, new FakeProvider());

  await assert.rejects(
    bridge.provision({
      instanceId: WORKSPACE_ID,
      ownerId: OWNER_ID,
      imageReference: "sha256:source",
      launchProfile: launchProfile("sha256:source"),
    }),
    /workspace_execution_app_id_required/u,
  );
});

test("the lifecycle bridge preserves a stopped replacement until its first healthy start", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeProvider(providerExecution());
  const bridge = createBridge(persistence, provider);

  const stopped = await bridge.stop(WORKSPACE_ID);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.endpoint, null);

  const candidate = await bridge.rebuild!({
    instanceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    appId: "sample-app",
    appVersionId: "revision-target",
    imageArtifactId: "artifact-target",
    imageReference: "sha256:target",
    sourceCatalogSnapshot: providerExecution().catalogSnapshot,
    launchProfile: launchProfile("sha256:target"),
    start: false,
    rebuildTransactionId: "rollout-attempt-target",
  });
  assert.equal(candidate.state, "stopped");
  assert.equal(candidate.endpoint, null);

  const deployed = await persistence.getWorkspaceExecutionProjection(WORKSPACE_ID);
  assert.equal(deployed?.execution.desiredGeneration, 2);
  assert.equal(deployed?.execution.deployedGeneration, 2);
  assert.equal(deployed?.execution.healthyGeneration, 1);
  assert.equal(deployed?.execution.transactionStatus, "awaiting_first_start");
  assert.equal(deployed?.execution.launchArtifactReference, "sha256:target");

  const restartedBridge = createBridge(persistence, provider);
  const running = await restartedBridge.start(WORKSPACE_ID);
  assert.equal(running.state, "running");
  assert.equal(running.endpoint, null);

  const healthy = await persistence.getWorkspaceExecutionProjection(WORKSPACE_ID);
  assert.equal(healthy?.execution.deployedGeneration, 2);
  assert.equal(healthy?.execution.healthyGeneration, 2);
  assert.equal(healthy?.execution.transactionStatus, "applied");
  assert.equal(provider.requests.filter((request) => request.replace).length, 1);
});

test("the lifecycle bridge returns the recovered baseline when a replacement rolls back", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeProvider(providerExecution());
  provider.rollbackNext = true;
  const bridge = createBridge(persistence, provider);

  const recovered = await bridge.rebuild!({
    instanceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    appId: "sample-app",
    appVersionId: "revision-target",
    imageArtifactId: "artifact-target",
    imageReference: "sha256:target",
    sourceCatalogSnapshot: providerExecution().catalogSnapshot,
    launchProfile: launchProfile("sha256:target"),
    rebuildTransactionId: "rollout-attempt-rollback",
  });

  assert.equal(recovered.rebuildRecovered, true);
  assert.equal(recovered.catalogSnapshot?.imageReference, "sha256:source");
  const projection = await persistence.getWorkspaceExecutionProjection(WORKSPACE_ID);
  assert.equal(projection?.execution.transactionStatus, "rolled_back");
  assert.equal(projection?.execution.deployedGeneration, 1);
  assert.equal(projection?.execution.launchArtifactReference, "sha256:source");
});

test("stop, start, same-image rebuild, image upgrade, and Portal restart preserve one storage binding", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeProvider(providerExecution());
  provider.sentinel = "workspace-sentinel-sha256";
  const firstPortal = createBridge(persistence, provider);

  await firstPortal.stop(WORKSPACE_ID);
  await firstPortal.start(WORKSPACE_ID);
  await firstPortal.rebuild!({
    instanceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    appId: "sample-app",
    appVersionId: "revision-source",
    imageArtifactId: "artifact-source",
    imageReference: "sha256:source",
    sourceCatalogSnapshot: providerExecution().catalogSnapshot,
    launchProfile: launchProfile("sha256:source"),
    rebuildTransactionId: "same-image-rebuild",
  });
  const restartedPortal = createBridge(persistence, provider);
  await restartedPortal.rebuild!({
    instanceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    appId: "sample-app",
    appVersionId: "revision-upgraded",
    imageArtifactId: "artifact-upgraded",
    imageReference: "sha256:upgraded",
    sourceCatalogSnapshot: providerExecution().catalogSnapshot,
    launchProfile: launchProfile("sha256:upgraded"),
    rebuildTransactionId: "image-upgrade-rebuild",
  });

  assert.equal(provider.sentinel, "workspace-sentinel-sha256");
  assert.ok(provider.requests.length >= 4);
  assert.deepEqual(new Set(provider.requests.flatMap((request) => (
    request.storageBindings.map((binding) => binding.attachmentRef)
  ))), new Set([`test-data-${WORKSPACE_ID}`]));
  assert.ok(provider.requests.every((request) => (
    request.storageBindings.length === 1
    && request.storageBindings[0]?.storageId === `workspace-storage:${WORKSPACE_ID}`
  )));
});

const WORKSPACE_ID = "bridge-workspace";
const OWNER_ID = "bridge-owner";
const ENVIRONMENT_ID = "bridge-environment";

class FakeProvider implements ExecutionControlPort, WorkspaceStorageBindingResolver, WorkspaceStorageReleasePort {
  readonly providerId = "docker";
  readonly requests: ExecutionReconcileRequest[] = [];
  execution: ProviderExecution | null;
  rollbackNext = false;
  sentinel: string | null = null;

  constructor(execution: ProviderExecution | null = null) {
    this.execution = execution;
  }

  async inspect(): Promise<ProviderExecution | null> {
    return this.execution ? structuredClone(this.execution) : null;
  }

  async observe(_request: ExecutionObservationRequest): Promise<ProviderExecution | null> {
    return this.execution ? structuredClone(this.execution) : null;
  }

  async resolveStorageBinding() {
    return {
      storageId: `workspace-storage:${WORKSPACE_ID}`,
      attachmentRef: `test-data-${WORKSPACE_ID}`,
      mountPath: "/var/lib/sample-app",
      readOnly: false,
    };
  }

  async reconcile(request: ExecutionReconcileRequest): Promise<ExecutionReconcileResult> {
    this.requests.push(structuredClone({ ...request, signal: undefined }));
    if (this.rollbackNext) {
      this.rollbackNext = false;
      return {
        status: "rolled_back",
        generation: request.desiredGeneration,
        transactionId: request.transactionId,
        execution: structuredClone(this.execution ?? providerExecution()),
      };
    }
    this.execution = {
      workspaceId: request.workspaceId,
      ownerId: request.ownerId,
      environmentRef: ENVIRONMENT_ID,
      observedState: request.desiredState,
      createdAt: this.execution?.createdAt ?? "2026-08-04T00:00:00.000Z",
      catalogSnapshot: {
        appId: request.appId,
        appVersionId: request.appRevisionId,
        imageArtifactId: request.launchArtifactId,
        imageReference: request.launchArtifactReference,
      },
    };
    return {
      status: request.replace && request.desiredState === "stopped" ? "awaiting_first_start" : "applied",
      generation: request.desiredGeneration,
      transactionId: request.transactionId,
      execution: structuredClone(this.execution),
    };
  }

  async removeEnvironment(): Promise<void> {
    this.execution = null;
  }

  async releaseWorkspaceStorage(): Promise<void> {}

}

function createBridge(persistence: MemoryPersistence, provider: FakeProvider): WorkspaceExecutionRuntimeBridge {
  const manager = new WorkspaceExecutionManager({
    store: persistence,
    provider,
    storageBindingResolver: provider,
    storageReleaser: provider,
    deletionDrain: {
      begin: async () => true,
      clear: async () => undefined,
    },
  });
  return new WorkspaceExecutionRuntimeBridge({
    manager,
    metrics: {
      async readMetrics() {
        return {
          status: "supported",
          value: {
            networkRxBytes: 0,
            networkTxBytes: 0,
            cpuPercent: 0,
            memoryWorkingSetBytes: 0,
            pids: 0,
          },
        };
      },
    },
    launchProfileFor: async (imageReference) => launchProfile(imageReference),
  });
}

function launchProfile(imageReference: string): ContainerLaunchProfile {
  return {
    imageReference,
    resources: { memory: "2g", cpus: "1", pidsLimit: 256 },
    environment: {},
    configFiles: [],
  };
}

function providerExecution(): ProviderExecution {
  return {
    workspaceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    environmentRef: ENVIRONMENT_ID,
    observedState: "running",
    createdAt: "2026-08-04T00:00:00.000Z",
    catalogSnapshot: {
      appId: "sample-app",
      appVersionId: "revision-source",
      imageArtifactId: "artifact-source",
      imageReference: "sha256:source",
    },
  };
}

function container(overrides: Partial<Container> = {}): Container {
  return {
    id: WORKSPACE_ID,
    userId: OWNER_ID,
    appId: "sample-app",
    runtimeId: ENVIRONMENT_ID,
    status: "running",
    endpoint: "http://127.0.0.1:37371",
    stopReason: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    appVersionId: "revision-source",
    imageArtifactId: "artifact-source",
    imageReference: "sha256:source",
    ...overrides,
  };
}
