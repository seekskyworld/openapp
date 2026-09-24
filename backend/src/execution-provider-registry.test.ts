import assert from "node:assert/strict";
import test from "node:test";
import { ContractProviderAdapter } from "./contract-provider-adapter.js";
import { DockerProviderAdapter } from "./docker-provider-adapter.js";
import { ExecutionProviderRegistry, ExecutionProviderRegistryError } from "./execution-provider-registry.js";
import { ProviderOperationError, type ExecutionReconcileRequest } from "./execution-provider.js";
import type { ProvisionContainerRequest } from "@openapp/container-runtime";
import type { ContainerRuntime } from "./runtime.js";
import type { Container } from "./models.js";
import { MemoryPersistence } from "./persistence/memory.js";
import { WorkspaceExecutionManager } from "./workspace-execution-manager.js";

const profile = {
  imageReference: "sha256:image",
  resources: { memory: "1g", cpus: "1", pidsLimit: 128 },
  environment: {},
  configFiles: [],
};

test("Provider registry validates descriptors and selects by capability contract", () => {
  const contract = new ContractProviderAdapter({ providerId: "daytona-contract" });
  const registry = new ExecutionProviderRegistry([contract], { defaultProviderId: "daytona-contract" });

  assert.equal(registry.defaultProviderId, "daytona-contract");
  assert.deepEqual(registry.descriptor("daytona-contract").capabilities, {
    rollback: "transactional",
    workloadHealth: "probe",
    metrics: true,
    diagnostics: true,
  });
  assert.equal(registry.select({ executionContract: "none" }), contract);
  assert.throws(
    () => registry.select({ storageClass: "unsupported" }),
    (error: unknown) => error instanceof ExecutionProviderRegistryError
      && error.code === "execution_provider_unsupported",
  );
});

test("registry rejects duplicate providers and a descriptor identity mismatch", () => {
  const first = new ContractProviderAdapter({ providerId: "contract-a" });
  assert.throws(
    () => new ExecutionProviderRegistry([first, new ContractProviderAdapter({ providerId: "contract-a" })]),
    (error: unknown) => error instanceof ExecutionProviderRegistryError
      && error.code === "execution_provider_duplicate_id",
  );

  const invalid = new ContractProviderAdapter({ providerId: "contract-b" });
  Object.defineProperty(invalid, "descriptor", {
    configurable: true,
    value: { ...invalid.descriptor, id: "contract-a" },
  });
  assert.throws(
    () => new ExecutionProviderRegistry([invalid]),
    (error: unknown) => error instanceof ExecutionProviderRegistryError
      && error.code === "execution_provider_invalid_descriptor",
  );
});

test("routed Provider keeps Workspace pins and does not cross-probe adapters", async () => {
  const docker = new DockerProviderAdapter(minimalRuntime());
  const contract = new ContractProviderAdapter({ providerId: "contract" });
  const providerByWorkspace = new Map<string, string>([["workspace-contract", "contract"]]);
  const registry = new ExecutionProviderRegistry([docker, contract]);
  const routed = registry.router({
    resolveProviderId: (workspaceId) => providerByWorkspace.get(workspaceId),
  });
  const request = reconcileRequest("workspace-contract", "contract-user", "contract");
  const result = await routed.reconcile(request);
  assert.equal(result.execution.providerId, "contract");
  assert.equal((await routed.inspect("workspace-contract", undefined, "contract"))?.providerId, "contract");
  const target = await routed.resolveAccessTarget({
    workspaceId: "workspace-contract",
    expectedOwnerId: "contract-user",
    providerId: "contract",
    logicalService: "workspace_ui",
  });
  assert.equal(target.providerId, "contract");
  assert.equal(await routed.inspect("workspace-contract", undefined, "docker"), null);
});

test("contract Provider distinguishes unsupported and unavailable optional capabilities", async () => {
  const unsupported = new ContractProviderAdapter({ providerId: "unsupported", metrics: "unsupported", health: "unsupported" });
  assert.deepEqual(await unsupported.readMetrics("missing"), { status: "unsupported" });
  assert.deepEqual(await unsupported.readProviderHealth(), { status: "unsupported" });

  const unavailable = new ContractProviderAdapter({ providerId: "unavailable", diagnostics: "unavailable", health: "unavailable" });
  const diagnostics = await unavailable.readDiagnostics("missing");
  assert.equal(diagnostics.status, "unavailable");
  if (diagnostics.status === "unavailable") assert.equal(diagnostics.error.code, "provider_diagnostics_unavailable");
  const health = await unavailable.readProviderHealth();
  assert.equal(health.status, "unavailable");
});

test("a pinned second Provider owns execution, access, storage, and deletion without Docker fallback", async () => {
  const persistence = new MemoryPersistence();
  const dockerWorkspace = container("legacy-docker-workspace", "legacy-docker-owner");
  const contractWorkspace = container("contract-workspace", "contract-owner", "contract");
  await persistence.saveContainer(dockerWorkspace);
  await persistence.saveContainer(contractWorkspace);

  const dockerRuntime = new RecordingDockerRuntime();
  dockerRuntime.instances.set(dockerWorkspace.id, runtimeInstance(dockerWorkspace.id, dockerWorkspace.userId));
  const docker = new DockerProviderAdapter(dockerRuntime);
  const contract = new RecordingContractProvider({ providerId: "contract" });
  const registry = new ExecutionProviderRegistry([docker, contract]);
  const routed = registry.router({
    resolveProviderId: async (workspaceId) => (
      (await persistence.getWorkspaceExecutionProjection(workspaceId))?.execution.providerId
    ),
  });
  const manager = new WorkspaceExecutionManager({
    store: persistence,
    provider: routed,
    storageBindingResolver: routed,
    storageReleaser: routed,
    transactions: routed,
    deletionDrain: { begin: async () => true, clear: async () => undefined },
  });

  const legacy = await manager.observe(dockerWorkspace.id);
  assert.equal(legacy?.environmentRef, dockerWorkspace.runtimeId);
  assert.equal(dockerRuntime.getCalls, 1);
  assert.equal(contract.reconcileCalls, 0);

  const contractProjection = await manager.reconcile({
    workspaceId: contractWorkspace.id,
    ownerId: contractWorkspace.userId,
    appId: contractWorkspace.appId,
    appRevisionId: "revision-contract",
    launchArtifactId: "artifact-contract",
    launchArtifactReference: profile.imageReference,
    launchProfile: profile,
    desiredState: "running",
    replace: false,
    transactionKey: "contract-provision",
  });
  assert.equal(contractProjection.execution.providerId, "contract");
  assert.equal(contract.reconcileCalls, 1);
  assert.equal(dockerRuntime.provisionCalls, 0);

  const observed = await manager.observe(contractWorkspace.id);
  assert.equal(observed?.providerId, "contract");
  const target = await routed.resolveAccessTarget({
    workspaceId: contractWorkspace.id,
    expectedOwnerId: contractWorkspace.userId,
    logicalService: "workspace_ui",
  });
  assert.equal(target.providerId, "contract");

  await manager.deleteWorkspace({ workspaceId: contractWorkspace.id });
  assert.equal(contract.removeCalls, 1);
  assert.equal(contract.releaseCalls, 1);
  assert.equal(dockerRuntime.removeCalls, 0);
  assert.equal(
    (await persistence.getWorkspaceExecutionProjection(contractWorkspace.id))?.workspace.status,
    "deleted",
  );
  assert.ok(await manager.getProjection(dockerWorkspace.id));
});

test("a pinned unavailable Provider fails without silently switching an existing Workspace", async () => {
  const persistence = new MemoryPersistence();
  const workspace = container("unavailable-contract-workspace", "unavailable-owner", "contract");
  await persistence.saveContainer(workspace);
  const dockerRuntime = new RecordingDockerRuntime();
  const docker = new DockerProviderAdapter(dockerRuntime);
  const unavailable = new UnavailableContractProvider({ providerId: "contract" });
  const registry = new ExecutionProviderRegistry([docker, unavailable]);
  const routed = registry.router({
    resolveProviderId: async () => "contract",
  });
  const manager = new WorkspaceExecutionManager({
    store: persistence,
    provider: routed,
    storageBindingResolver: routed,
    storageReleaser: routed,
    deletionDrain: { begin: async () => true, clear: async () => undefined },
  });

  await assert.rejects(
    manager.reconcile({
      workspaceId: workspace.id,
      ownerId: workspace.userId,
      appId: workspace.appId,
      appRevisionId: "revision-contract",
      launchArtifactId: "artifact-contract",
      launchArtifactReference: profile.imageReference,
      launchProfile: profile,
      desiredState: "running",
      replace: false,
      transactionKey: "contract-unavailable",
    }),
    (error: unknown) => error instanceof ProviderOperationError
      && error.code === "contract_provider_unavailable",
  );
  assert.equal(dockerRuntime.provisionCalls, 0);
  assert.equal((await persistence.getWorkspaceExecutionProjection(workspace.id))?.execution.transactionStatus, "failed");
});

test("selectAvailable classifies a supported health response with available=false as unavailable", async () => {
  const unavailable = new ContractProviderAdapter({ providerId: "unavailable", health: "available" });
  unavailable.readProviderHealth = async () => ({
    status: "supported",
    value: { providerId: "unavailable", available: false },
  });
  const registry = new ExecutionProviderRegistry([unavailable]);
  await assert.rejects(
    registry.selectAvailable(),
    (error: unknown) => error instanceof ExecutionProviderRegistryError
      && error.code === "execution_provider_unavailable",
  );
});

function reconcileRequest(workspaceId: string, ownerId: string, providerId: string) {
  return {
    workspaceId,
    ownerId,
    providerId,
    appId: "plain-web",
    appRevisionId: "revision-1",
    launchArtifactId: "artifact-1",
    launchArtifactReference: profile.imageReference,
    launchProfile: profile,
    storageBindings: [{
      storageId: `workspace-storage:${workspaceId}`,
      attachmentRef: `${providerId}-storage-${workspaceId}`,
      mountPath: "/var/lib/workspace",
      readOnly: false,
    }],
    desiredState: "running" as const,
    desiredGeneration: 1,
    transactionId: `transaction-${workspaceId}`,
    replace: false,
  };
}

function minimalRuntime(): ContainerRuntime {
  return {
    async provision() { throw new Error("unused"); },
    async get() { return null; },
    async start() { throw new Error("unused"); },
    async stop() { throw new Error("unused"); },
    async sampleActivity() { throw new Error("unused"); },
    async remove() {},
  };
}

class RecordingContractProvider extends ContractProviderAdapter {
  reconcileCalls = 0;
  removeCalls = 0;
  releaseCalls = 0;

  override async reconcile(request: ExecutionReconcileRequest) {
    this.reconcileCalls += 1;
    return super.reconcile(request);
  }

  override async removeEnvironment(request: Parameters<ContractProviderAdapter["removeEnvironment"]>[0]) {
    this.removeCalls += 1;
    return super.removeEnvironment(request);
  }

  override async releaseWorkspaceStorage(request: Parameters<ContractProviderAdapter["releaseWorkspaceStorage"]>[0]) {
    this.releaseCalls += 1;
    return super.releaseWorkspaceStorage(request);
  }
}

class UnavailableContractProvider extends ContractProviderAdapter {
  override async reconcile(_request: ExecutionReconcileRequest): Promise<never> {
    throw new ProviderOperationError("contract_provider_unavailable", "transient", "reconcile");
  }
}

class RecordingDockerRuntime implements ContainerRuntime {
  readonly instances = new Map<string, ReturnType<typeof runtimeInstance>>();
  getCalls = 0;
  provisionCalls = 0;
  removeCalls = 0;

  async resolveStorageBinding(request: { workspaceId: string; storageId: string }) {
    return {
      storageId: request.storageId,
      attachmentRef: `docker-storage-${request.workspaceId}`,
      mountPath: "/var/lib/sample-app",
      readOnly: false,
    };
  }

  async provision(request: ProvisionContainerRequest) {
    this.provisionCalls += 1;
    const instance = runtimeInstance(request.instanceId, request.ownerId);
    this.instances.set(request.instanceId, instance);
    return structuredClone(instance);
  }

  async get(instanceId: string) {
    this.getCalls += 1;
    return structuredClone(this.instances.get(instanceId) ?? null);
  }

  async start(instanceId: string) {
    const current = this.instances.get(instanceId);
    if (!current) throw new Error("docker_runtime_missing");
    const updated = { ...current, state: "running" as const };
    this.instances.set(instanceId, updated);
    return structuredClone(updated);
  }

  async stop(instanceId: string) {
    const current = this.instances.get(instanceId);
    if (!current) throw new Error("docker_runtime_missing");
    const updated = { ...current, state: "stopped" as const, endpoint: null };
    this.instances.set(instanceId, updated);
    return structuredClone(updated);
  }

  async sampleActivity() {
    return { networkRxBytes: 0, networkTxBytes: 0, cpuPercent: 0, memoryWorkingSetBytes: 0, pids: 1 };
  }

  async removeEnvironment(request: { instanceId: string }) {
    this.removeCalls += 1;
    this.instances.delete(request.instanceId);
  }

  async releaseWorkspaceStorage() {}

  async remove(instanceId: string) {
    this.instances.delete(instanceId);
  }
}

function container(id: string, userId: string, providerId?: string): Container {
  return {
    id,
    userId,
    appId: "plain-web",
    ...(providerId ? { providerId } : {}),
    runtimeId: providerId === "contract" ? "pending" : `${id}-runtime`,
    status: providerId === "contract" ? "creating" : "running",
    endpoint: providerId === "contract" ? null : "http://127.0.0.1:37000",
    stopReason: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    appVersionId: "version-source",
    imageArtifactId: "artifact-source",
    imageReference: "sha256:source",
  };
}

function runtimeInstance(instanceId: string, ownerId: string) {
  return {
    instanceId,
    ownerId,
    runtimeId: `${instanceId}-runtime`,
    state: "running" as "running" | "stopped",
    endpoint: "http://127.0.0.1:37000" as string | null,
    createdAt: "2026-08-04T00:00:00.000Z",
  };
}
