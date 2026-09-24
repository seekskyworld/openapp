import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExecutionControlPort,
  ExecutionEnvironmentRemovalRequest,
  ExecutionObservationRequest,
  ExecutionReconcileRequest,
  ExecutionReconcileResult,
  ProviderExecution,
  StorageBindingResolutionRequest,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort,
  WorkspaceStorageReleaseRequest,
} from "./execution-provider.js";
import { ProviderOperationError } from "./execution-provider.js";
import type { Container } from "./models.js";
import { MemoryPersistence } from "./persistence/memory.js";
import {
  WorkspaceExecutionManager,
  WorkspaceExecutionStateError,
  executionTransactionId,
  type WorkspaceDeletionDrainPort,
  type WorkspaceExecutionStore,
} from "./workspace-execution-manager.js";

test("WorkspaceExecutionManager allocates one generation and replays a completed transaction", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  const manager = executionManager(persistence, provider);
  const input = rebuildInput();

  const first = await manager.reconcile(input);
  const replay = await manager.reconcile(input);

  assert.equal(first.execution.desiredGeneration, 2);
  assert.equal(first.execution.deployedGeneration, 2);
  assert.equal(first.execution.healthyGeneration, 1);
  assert.equal(first.execution.transactionStatus, "awaiting_first_start");
  assert.equal(first.execution.desiredLaunchArtifactReference, "sha256:target");
  assert.equal(first.execution.launchArtifactReference, "sha256:target");
  assert.equal(first.execution.transactionId, executionTransactionId(input.workspaceId, input.transactionKey));
  assert.deepEqual(replay, first);
  assert.equal(provider.reconcileRequests.length, 1);
  assert.deepEqual(provider.storageRequests, [{
    workspaceId: "execution-manager-workspace",
    ownerId: "execution-manager-owner",
    providerId: "docker",
    storageRef: {
      id: "workspace-storage:execution-manager-workspace",
      storageClass: "workspace-data",
      affinity: { providerId: "docker" },
    },
    signal: undefined,
  }]);
  assert.deepEqual(provider.reconcileRequests[0]?.storageBindings, [{
    storageId: "workspace-storage:execution-manager-workspace",
    attachmentRef: "test-data-execution-manager-workspace",
    mountPath: "/var/lib/sample-app",
    readOnly: false,
  }]);
});

test("WorkspaceExecutionManager commits the next healthy generation without lowering prior proof", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  const manager = executionManager(persistence, provider);

  await manager.reconcile(rebuildInput());
  const running = await manager.reconcile({
    ...rebuildInput(),
    transactionKey: "rollout-attempt-running",
    appRevisionId: "target-release-running",
    launchArtifactId: "target-artifact-running",
    launchArtifactReference: "sha256:target-running",
    launchProfile: {
      ...rebuildInput().launchProfile,
      imageReference: "sha256:target-running",
    },
    desiredState: "running",
  });

  assert.equal(running.execution.desiredGeneration, 3);
  assert.equal(running.execution.deployedGeneration, 3);
  assert.equal(running.execution.healthyGeneration, 3);
  assert.equal(running.execution.transactionStatus, "applied");
  assert.equal(running.workspace.appRevisionId, "target-release-running");
});

test("WorkspaceExecutionManager persists a typed provider failure without committing deployment", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  provider.failure = new ProviderOperationError(
    "provider_artifact_incompatible",
    "permanent",
    "reconcile",
  );
  const manager = executionManager(persistence, provider);

  await assert.rejects(manager.reconcile(rebuildInput()), (error: unknown) => (
    error instanceof ProviderOperationError
    && error.code === "provider_artifact_incompatible"
    && error.failureClass === "permanent"
  ));
  const projection = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  assert.equal(projection?.execution.desiredGeneration, 2);
  assert.equal(projection?.execution.deployedGeneration, 1);
  assert.equal(projection?.execution.transactionStatus, "failed");
  assert.equal(projection?.execution.launchArtifactReference, "sha256:source");
});

test("WorkspaceExecutionManager rejects an untrusted storage class before persisting intent", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  const before = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  let writes = 0;
  const store: WorkspaceExecutionStore = {
    getWorkspaceExecutionProjection: (id) => persistence.getWorkspaceExecutionProjection(id),
    compareAndSaveWorkspaceExecution: (projection, revision) => {
      writes += 1;
      return persistence.compareAndSaveWorkspaceExecution(projection, revision);
    },
    countLiveWorkspaceStorageReferences: (storageRefId, excludingWorkspaceId) => (
      persistence.countLiveWorkspaceStorageReferences(storageRefId, excludingWorkspaceId)
    ),
  };
  const manager = executionManager(store, provider);

  await assert.rejects(manager.reconcile({
    ...rebuildInput(),
    storageClass: "untrusted-storage",
  }), (error: unknown) => (
    error instanceof WorkspaceExecutionStateError && error.code === "workspace_storage_class_mismatch"
  ));

  const projection = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  assert.equal(writes, 0);
  assert.equal(provider.reconcileRequests.length, 0);
  assert.equal(projection?.execution.transactionId, before?.execution.transactionId);
  assert.equal(projection?.execution.desiredGeneration, before?.execution.desiredGeneration);
  assert.equal(projection?.execution.revision, before?.execution.revision);
});

test("WorkspaceExecutionManager resolves the trusted storage binding for mutating observations", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  const manager = executionManager(persistence, provider);

  const observed = await manager.observe("execution-manager-workspace");

  assert.equal(observed?.environmentRef, "execution-manager-runtime");
  assert.deepEqual(provider.observeRequests, [{
    workspaceId: "execution-manager-workspace",
    expectedOwnerId: "execution-manager-owner",
    storageBindings: [{
      storageId: "workspace-storage:execution-manager-workspace",
      attachmentRef: "test-data-execution-manager-workspace",
      mountPath: "/var/lib/sample-app",
      readOnly: false,
    }],
    signal: undefined,
  }]);
});

test("WorkspaceExecutionManager records storage resolution failure without invoking the Provider", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  provider.storageFailure = new ProviderOperationError(
    "provider_storage_binding_invalid",
    "inconsistent",
    "resolve_storage",
  );
  const manager = executionManager(persistence, provider);

  await assert.rejects(
    manager.reconcile(rebuildInput()),
    /provider_storage_binding_invalid/u,
  );

  assert.equal(provider.reconcileRequests.length, 0);
  const projection = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  assert.equal(projection?.execution.transactionStatus, "inconsistent");
  assert.equal(projection?.execution.deployedGeneration, 1);
});

test("legacy lifecycle persistence is routed through Execution CAS after generation cutover", async () => {
  const persistence = new MemoryPersistence();
  const source = container();
  await persistence.saveContainer(source);
  const provider = new FakeExecutionProvider();
  const manager = executionManager(persistence, provider);
  await manager.reconcile(rebuildInput());

  await manager.persistLegacyContainer({
    ...(await persistence.getContainer(source.id))!,
    status: "failed",
    endpoint: null,
    stopReason: "failure",
    updatedAt: "2026-08-04T00:05:00.000Z",
  });

  const projection = await persistence.getWorkspaceExecutionProjection(source.id);
  assert.equal(projection?.execution.revision, 4);
  assert.equal(projection?.execution.desiredGeneration, 2);
  assert.equal(projection?.execution.deployedGeneration, 2);
  assert.equal(projection?.execution.observedState, "failed");
  assert.equal((await persistence.getContainer(source.id))?.status, "failed");
});

test("a late Provider result cannot overwrite a newer desired generation", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new OrderedExecutionProvider();
  const manager = executionManager(persistence, provider);

  const first = manager.reconcile(rebuildInput());
  await provider.firstRequested;
  const secondInput = {
    ...rebuildInput(),
    transactionKey: "rollout-attempt-newer",
    appRevisionId: "target-release-newer",
    launchArtifactId: "target-artifact-newer",
    launchArtifactReference: "sha256:target-newer",
    launchProfile: {
      ...rebuildInput().launchProfile,
      imageReference: "sha256:target-newer",
    },
  };
  const second = await manager.reconcile(secondInput);
  provider.releaseFirst();

  await assert.rejects(first, /workspace_execution_transaction_superseded/u);
  const current = await persistence.getWorkspaceExecutionProjection(secondInput.workspaceId);
  assert.equal(second.execution.desiredGeneration, 3);
  assert.equal(current?.execution.deployedGeneration, 3);
  assert.equal(current?.execution.launchArtifactReference, "sha256:target-newer");
  assert.equal(current?.execution.transactionStatus, "awaiting_first_start");
});

test("Workspace deletion drains, removes Environment, releases Storage, and retains an idempotent tombstone", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  const events: string[] = [];
  provider.events = events;
  const manager = executionManager(persistence, provider, {
    begin: async () => { events.push("drain"); return true; },
    clear: async () => { events.push("clear"); },
  });

  const deleted = await manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" });
  const replay = await manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" });

  assert.equal(deleted.workspace.status, "deleted");
  assert.equal(deleted.workspace.deletionPhase, "deleted");
  assert.ok(deleted.workspace.deletedAt);
  assert.equal(deleted.workspace.activeExecutionId, null);
  assert.equal(deleted.execution.role, "retired");
  assert.equal(deleted.execution.observedState, "absent");
  assert.equal(await persistence.getContainer(deleted.workspace.id), null);
  assert.deepEqual(replay, deleted);
  assert.deepEqual(events, ["drain", "remove_environment", "release_storage", "clear", "clear"]);
  assert.equal(provider.removeRequests.length, 1);
  assert.equal(provider.releaseRequests.length, 1);
  await assert.rejects(manager.observe(deleted.workspace.id), (error: unknown) => (
    error instanceof WorkspaceExecutionStateError && error.code === "workspace_deleted"
  ));
  await assert.rejects(manager.reconcile(rebuildInput()), (error: unknown) => (
    error instanceof WorkspaceExecutionStateError && error.code === "workspace_deleted"
  ));
  await assert.rejects(persistence.saveContainer(container()), /workspace_execution_cas_required/u);
});

test("Workspace deletion retries a failed Environment phase without releasing Storage early", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  provider.removeFailure = new ProviderOperationError("provider_remove_timeout", "transient", "remove");
  const manager = executionManager(persistence, provider);

  await assert.rejects(manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" }), /provider_remove_timeout/u);
  const failed = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  assert.equal(failed?.workspace.status, "deleting");
  assert.equal(failed?.workspace.deletionPhase, "removing_environments");
  assert.equal(failed?.workspace.deletionFailure, "provider_remove_timeout");
  assert.equal(provider.releaseRequests.length, 0);
  await assert.rejects(manager.observe("execution-manager-workspace"), (error: unknown) => (
    error instanceof WorkspaceExecutionStateError && error.code === "workspace_deleting"
  ));

  provider.removeFailure = null;
  const deleted = await manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" });
  assert.equal(deleted.workspace.status, "deleted");
  assert.equal(provider.removeRequests.length, 2);
  assert.equal(provider.releaseRequests.length, 1);
});

test("Workspace deletion preserves the releasing phase and safely repeats an already-applied storage release", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  provider.releaseFailure = new ProviderOperationError("provider_release_response_lost", "transient", "remove");
  const manager = executionManager(persistence, provider);

  await assert.rejects(manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" }), /provider_release_response_lost/u);
  const failed = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  assert.equal(failed?.workspace.deletionPhase, "releasing_storage");
  assert.equal(failed?.workspace.deletionFailure, "provider_release_response_lost");

  provider.releaseFailure = null;
  const deleted = await manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" });
  assert.equal(deleted.workspace.status, "deleted");
  assert.equal(provider.removeRequests.length, 1);
  assert.equal(provider.releaseRequests.length, 2);
});

test("Workspace deletion retries drain cleanup after the tombstone is durable", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  let clearAttempts = 0;
  const manager = executionManager(persistence, provider, {
    begin: async () => true,
    clear: async () => {
      clearAttempts += 1;
      if (clearAttempts === 1) throw new Error("drain_clear_failed");
    },
  });

  await assert.rejects(
    manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" }),
    /drain_clear_failed/u,
  );
  assert.equal(
    (await persistence.getWorkspaceExecutionProjection("execution-manager-workspace"))?.workspace.status,
    "deleted",
  );
  assert.equal(provider.removeRequests.length, 1);
  assert.equal(provider.releaseRequests.length, 1);

  const replay = await manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" });
  assert.equal(replay.workspace.status, "deleted");
  assert.equal(clearAttempts, 2);
  assert.equal(provider.removeRequests.length, 1);
  assert.equal(provider.releaseRequests.length, 1);
});

test("Workspace deletion fails closed when another live Workspace references the same StorageRef", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  const store: WorkspaceExecutionStore = {
    getWorkspaceExecutionProjection: (id) => persistence.getWorkspaceExecutionProjection(id),
    compareAndSaveWorkspaceExecution: (projection, revision) => (
      persistence.compareAndSaveWorkspaceExecution(projection, revision)
    ),
    countLiveWorkspaceStorageReferences: async () => 1,
  };
  const manager = executionManager(store, provider);

  await assert.rejects(manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" }), (error: unknown) => (
    error instanceof WorkspaceExecutionStateError && error.code === "workspace_storage_still_referenced"
  ));

  const failed = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  assert.equal(failed?.workspace.deletionPhase, "removing_environments");
  assert.equal(provider.removeRequests.length, 0);
  assert.equal(provider.releaseRequests.length, 0);
});

test("Workspace deletion rechecks external references immediately before releasing Storage", async () => {
  const persistence = new MemoryPersistence();
  await persistence.saveContainer(container());
  const provider = new FakeExecutionProvider();
  let referenceChecks = 0;
  const store: WorkspaceExecutionStore = {
    getWorkspaceExecutionProjection: (id) => persistence.getWorkspaceExecutionProjection(id),
    compareAndSaveWorkspaceExecution: (projection, revision) => (
      persistence.compareAndSaveWorkspaceExecution(projection, revision)
    ),
    countLiveWorkspaceStorageReferences: async () => {
      referenceChecks += 1;
      return referenceChecks >= 3 ? 1 : 0;
    },
  };
  const manager = executionManager(store, provider);

  await assert.rejects(manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" }), (error: unknown) => (
    error instanceof WorkspaceExecutionStateError && error.code === "workspace_storage_still_referenced"
  ));

  const failed = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
  assert.equal(referenceChecks, 3);
  assert.equal(failed?.workspace.deletionPhase, "releasing_storage");
  assert.equal(provider.removeRequests.length, 1);
  assert.equal(provider.releaseRequests.length, 0);
});

test("Workspace deletion resumes after a database commit failure at every durable phase boundary", async (t) => {
  const cases = [
    ["removing_environments", "draining"],
    ["verifying_references", "removing_environments"],
    ["releasing_storage", "verifying_references"],
    ["finalizing", "releasing_storage"],
    ["deleted", "finalizing"],
  ] as const;
  for (const [failedWrite, retainedPhase] of cases) {
    await t.test(failedWrite, async () => {
      const persistence = new MemoryPersistence();
      await persistence.saveContainer(container());
      const provider = new FakeExecutionProvider();
      let injectFailure = true;
      const store: WorkspaceExecutionStore = {
        getWorkspaceExecutionProjection: (id) => persistence.getWorkspaceExecutionProjection(id),
        compareAndSaveWorkspaceExecution: (projection, revision) => {
          if (injectFailure && projection.workspace.deletionPhase === failedWrite) {
            injectFailure = false;
            throw new Error("database_commit_failed");
          }
          return persistence.compareAndSaveWorkspaceExecution(projection, revision);
        },
        countLiveWorkspaceStorageReferences: (storageRefId, excludingWorkspaceId) => (
          persistence.countLiveWorkspaceStorageReferences(storageRefId, excludingWorkspaceId)
        ),
      };
      const manager = executionManager(store, provider);

      await assert.rejects(
        manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" }),
        /database_commit_failed/u,
      );
      const interrupted = await persistence.getWorkspaceExecutionProjection("execution-manager-workspace");
      assert.equal(interrupted?.workspace.status, "deleting");
      assert.equal(interrupted?.workspace.deletionPhase, retainedPhase);
      assert.equal(interrupted?.workspace.deletionFailure, "workspace_deletion_failed");

      const deleted = await manager.deleteWorkspace({ workspaceId: "execution-manager-workspace" });
      assert.equal(deleted.workspace.status, "deleted");
    });
  }
});

class FakeExecutionProvider implements
  ExecutionControlPort,
  WorkspaceStorageBindingResolver,
  WorkspaceStorageReleasePort {
  readonly providerId = "docker";
  readonly reconcileRequests: ExecutionReconcileRequest[] = [];
  readonly storageRequests: StorageBindingResolutionRequest[] = [];
  readonly observeRequests: ExecutionObservationRequest[] = [];
  readonly removeRequests: ExecutionEnvironmentRemovalRequest[] = [];
  readonly releaseRequests: WorkspaceStorageReleaseRequest[] = [];
  failure: ProviderOperationError | null = null;
  storageFailure: ProviderOperationError | null = null;
  removeFailure: ProviderOperationError | null = null;
  releaseFailure: ProviderOperationError | null = null;
  events: string[] | null = null;
  execution: ProviderExecution = {
    workspaceId: "execution-manager-workspace",
    ownerId: "execution-manager-owner",
    environmentRef: "execution-manager-runtime",
    observedState: "running",
    createdAt: "2026-08-04T00:00:00.000Z",
  };

  async inspect(): Promise<ProviderExecution> { return structuredClone(this.execution); }
  async observe(request: ExecutionObservationRequest): Promise<ProviderExecution> {
    this.observeRequests.push(structuredClone({ ...request, signal: undefined }));
    return structuredClone(this.execution);
  }
  async removeEnvironment(request: ExecutionEnvironmentRemovalRequest): Promise<void> {
    this.removeRequests.push(structuredClone({ ...request, signal: undefined }));
    this.events?.push("remove_environment");
    if (this.removeFailure) throw this.removeFailure;
  }

  async releaseWorkspaceStorage(request: WorkspaceStorageReleaseRequest): Promise<void> {
    this.releaseRequests.push(structuredClone({ ...request, signal: undefined }));
    this.events?.push("release_storage");
    if (this.releaseFailure) throw this.releaseFailure;
  }

  async resolveStorageBinding(request: StorageBindingResolutionRequest) {
    this.storageRequests.push(structuredClone({ ...request, signal: undefined }));
    if (this.storageFailure) throw this.storageFailure;
    return {
      storageId: request.storageRef.id,
      attachmentRef: `test-data-${request.workspaceId}`,
      mountPath: "/var/lib/sample-app",
      readOnly: false,
    };
  }

  async reconcile(request: ExecutionReconcileRequest): Promise<ExecutionReconcileResult> {
    this.reconcileRequests.push(structuredClone({ ...request, signal: undefined }));
    if (this.failure) throw this.failure;
    this.execution = {
      ...this.execution,
      observedState: request.desiredState,
      catalogSnapshot: {
        appId: request.appId,
        appVersionId: request.appRevisionId,
        imageArtifactId: request.launchArtifactId,
        imageReference: request.launchArtifactReference,
      },
    };
    return {
      status: request.desiredState === "stopped" ? "awaiting_first_start" : "applied",
      generation: request.desiredGeneration,
      transactionId: request.transactionId,
      execution: structuredClone(this.execution),
    };
  }
}

function executionManager(
  store: WorkspaceExecutionStore,
  provider: FakeExecutionProvider,
  deletionDrain: WorkspaceDeletionDrainPort = {
    begin: async () => true,
    clear: async () => undefined,
  },
): WorkspaceExecutionManager {
  return new WorkspaceExecutionManager({
    store,
    provider,
    storageBindingResolver: provider,
    storageReleaser: provider,
    deletionDrain,
  });
}

class OrderedExecutionProvider extends FakeExecutionProvider {
  readonly firstRequested: Promise<void>;
  readonly #markFirstRequested: () => void;
  readonly #firstRelease: Promise<void>;
  readonly #releaseFirst: () => void;
  #requests = 0;

  constructor() {
    super();
    let markFirstRequested!: () => void;
    let releaseFirst!: () => void;
    this.firstRequested = new Promise<void>((resolve) => { markFirstRequested = resolve; });
    this.#firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    this.#markFirstRequested = markFirstRequested;
    this.#releaseFirst = releaseFirst;
  }

  releaseFirst(): void {
    this.#releaseFirst();
  }

  override async reconcile(request: ExecutionReconcileRequest): Promise<ExecutionReconcileResult> {
    this.#requests += 1;
    if (this.#requests === 1) {
      this.#markFirstRequested();
      await this.#firstRelease;
    }
    return super.reconcile(request);
  }
}

function rebuildInput() {
  return {
    workspaceId: "execution-manager-workspace",
    ownerId: "execution-manager-owner",
    appId: "sample-app",
    appRevisionId: "target-release",
    launchArtifactId: "target-artifact",
    launchArtifactReference: "sha256:target",
    launchProfile: {
      imageReference: "sha256:target",
      resources: { memory: "2g", cpus: "1", pidsLimit: 256 },
      environment: {},
      configFiles: [],
    },
    desiredState: "stopped" as const,
    replace: true,
    transactionKey: "rollout-attempt-stopped",
  };
}

function container(): Container {
  return {
    id: "execution-manager-workspace",
    userId: "execution-manager-owner",
    appId: "sample-app",
    runtimeId: "execution-manager-runtime",
    status: "running",
    endpoint: "http://127.0.0.1:37371",
    stopReason: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    appVersionId: "source-release",
    imageArtifactId: "source-artifact",
    imageReference: "sha256:source",
  };
}
