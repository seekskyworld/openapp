import assert from "node:assert/strict";
import test from "node:test";

import {
  assertProviderRequestSupported,
  parseCpuMillis,
  parseMemoryBytes,
  providerNotFound,
  providerRequestFromReconcile,
} from "./provider-adapter-contract.js";
import { ContractProviderAdapter } from "./contract-provider-adapter.js";
import { DockerProviderAdapter } from "./docker-provider-adapter.js";
import { ProviderOperationError, type ExecutionReconcileRequest } from "./execution-provider.js";
import { ExecutionProviderRegistry, type ProviderDescriptor } from "./execution-provider-registry.js";
import type { ContainerRuntime } from "./runtime.js";
import { createContainerRuntimeStub } from "./testing/container-runtime-stub.js";

test("container Runtime test stub defaults to the neutral storage root", async () => {
  const runtime = createContainerRuntimeStub({});
  assert.deepEqual(await runtime.resolveStorageBinding?.({
    workspaceId: "generic-workspace",
    ownerId: "generic-owner",
    storageId: "workspace-storage:generic-workspace",
    storageClass: "workspace-data",
  }), {
    storageId: "workspace-storage:generic-workspace",
    attachmentRef: "test-data-generic-workspace",
    mountPath: "/var/lib/openapp",
    readOnly: false,
  });
  const legacy = createContainerRuntimeStub({}, {
    storageMountPath: "/var/lib/legacy-app",
    storageAttachmentPrefix: "legacy-data-",
  });
  assert.equal((await legacy.resolveStorageBinding?.({
    workspaceId: "legacy-workspace",
    ownerId: "legacy-owner",
    storageId: "workspace-storage:legacy-workspace",
    storageClass: "workspace-data",
  }))?.mountPath, "/var/lib/legacy-app");
});

test("resource parsers accept bounded decimal units and reject ambiguous values", () => {
  assert.equal(parseMemoryBytes("2g"), 2 * 1024 ** 3);
  assert.equal(parseMemoryBytes("1.5M"), 1.5 * 1024 ** 2);
  assert.equal(parseMemoryBytes(""), undefined);
  assert.equal(parseMemoryBytes("2gb"), undefined);
  assert.equal(parseMemoryBytes("-1g"), undefined);
  assert.equal(parseCpuMillis("1.5"), 1_500);
  assert.equal(parseCpuMillis("2"), 2_000);
  assert.equal(parseCpuMillis("1e2"), undefined);
  assert.equal(parseCpuMillis("0"), undefined);
});

test("Provider request contracts enforce artifact, execution, storage and resource limits", () => {
  const descriptor = descriptorFor("bounded", {
    minMemoryBytes: 1024,
    maxMemoryBytes: 4096,
    minCpuMillis: 500,
    maxCpuMillis: 2_000,
    minPidsLimit: 16,
    maxPidsLimit: 128,
  });
  assert.doesNotThrow(() => assertProviderRequestSupported(descriptor, {
    artifactKind: "oci-image",
    executionContract: "generic-v1",
    storageClass: "workspace-data",
    memoryBytes: 2048,
    cpuMillis: 1_000,
    pidsLimit: 64,
  }));

  for (const [field, value, code] of [
    ["artifactKind", "wasm", "provider_artifact_unsupported"],
    ["executionContract", "sample-app-v1", "provider_execution_contract_unsupported"],
    ["storageClass", "ephemeral", "provider_storage_class_unsupported"],
  ] as const) {
    assert.throws(
      () => assertProviderRequestSupported(descriptor, { [field]: value }),
      (error: unknown) => error instanceof ProviderOperationError
        && error.code === code
        && error.failureClass === "permanent"
        && error.phase === "reconcile",
    );
  }

  for (const [field, value, code] of [
    ["memoryBytes", 512, "provider_memory_limit_unsupported"],
    ["cpuMillis", 3_000, "provider_cpu_limit_unsupported"],
    ["pidsLimit", 256, "provider_pids_limit_unsupported"],
    ["memoryBytes", Number.NaN, "provider_memory_limit_unsupported"],
  ] as const) {
    assert.throws(
      () => assertProviderRequestSupported(descriptor, { [field]: value }),
      (error: unknown) => error instanceof ProviderOperationError && error.code === code,
    );
  }
});

test("reconcile requests keep App contract separate from the launch profile", () => {
  const request = reconcileRequest({
    artifactKind: "oci-image",
    executionContract: "generic-v1",
    storageClass: "workspace-data",
  });
  assert.deepEqual(providerRequestFromReconcile(request), {
    artifactKind: "oci-image",
    executionContract: "generic-v1",
    storageClass: "workspace-data",
    memoryBytes: 2 * 1024 ** 3,
    cpuMillis: 1_000,
    pidsLimit: 256,
  });
  assert.throws(
    () => providerRequestFromReconcile(reconcileRequest({
      launchProfile: {
        ...reconcileRequest().launchProfile,
        resources: { memory: "not-a-size", cpus: "1", pidsLimit: 256 },
      },
    })),
    (error: unknown) => error instanceof ProviderOperationError
      && error.code === "provider_memory_limit_invalid",
  );
});

test("routed Provider rejects an unsupported contract before adapter side effects", async () => {
  const adapter = new RecordingContractAdapter();
  const registry = new ExecutionProviderRegistry([adapter], { defaultProviderId: adapter.providerId });
  const routed = registry.router();
  await assert.rejects(
    routed.reconcile(reconcileRequest({ providerId: adapter.providerId, executionContract: "unsupported-v1" })),
    (error: unknown) => error instanceof ProviderOperationError
      && error.code === "provider_execution_contract_unsupported",
  );
  assert.equal(adapter.reconcileCalls, 0);
});

test("Docker adapter repeats the preflight and does not inspect Docker on invalid resources", async () => {
  let getCalls = 0;
  const runtime = createContainerRuntimeStub({
    async get() {
      getCalls += 1;
      return null;
    },
  });
  const adapter = new DockerProviderAdapter(runtime);
  await assert.rejects(
    adapter.reconcile(reconcileRequest({ executionContract: "unsupported-v1" })),
    (error: unknown) => error instanceof ProviderOperationError
      && error.code === "provider_execution_contract_unsupported",
  );
  assert.equal(getCalls, 0);
});

test("Provider descriptors are explicitly scoped to the loaded App contracts", async () => {
  const generic = new DockerProviderAdapter(createContainerRuntimeStub({}), {
    compatibilityMode: false,
    supportedExecutionContracts: ["generic-v1", "none"],
  });
  assert.deepEqual(generic.descriptor.supportedExecutionContracts, ["generic-v1", "none"]);
  await assert.rejects(
    generic.reconcile(reconcileRequest({ executionContract: "sample-app-v1" })),
    (error: unknown) => error instanceof ProviderOperationError
      && error.code === "provider_execution_contract_unsupported",
  );

  const legacy = new DockerProviderAdapter(createContainerRuntimeStub({}), {
    compatibilityMode: true,
    supportedExecutionContracts: ["generic-v1", "none", "sample-app-v1"],
  });
  assert.equal(legacy.descriptor.supportedExecutionContracts.includes("sample-app-v1"), true);

  const custom = new ContractProviderAdapter({
    providerId: "custom-contract",
    supportedExecutionContracts: ["story-v1"],
  });
  assert.deepEqual(custom.descriptor.supportedExecutionContracts, ["story-v1"]);
  await assert.rejects(
    custom.reconcile(reconcileRequest({ providerId: "custom-contract", executionContract: "generic-v1" })),
    (error: unknown) => error instanceof ProviderOperationError
      && error.code === "provider_execution_contract_unsupported",
  );
  await custom.reconcile(reconcileRequest({ providerId: "custom-contract", executionContract: "story-v1" }));
});

test("selectAvailable maps health probe exceptions to unavailable and preserves aborts", async () => {
  const adapter = new ContractProviderAdapter({ providerId: "probe-failure" });
  adapter.readProviderHealth = async () => {
    throw new Error("provider timeout");
  };
  const registry = new ExecutionProviderRegistry([adapter]);
  await assert.rejects(
    registry.selectAvailable(),
    (error: unknown) => error instanceof Error && "code" in error
      && (error as { code?: string }).code === "execution_provider_unavailable",
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(registry.selectAvailable({}, controller.signal));
});

test("provider not-found errors carry stable phase and permanent classification", () => {
  const error = providerNotFound("provider_environment_not_found", "resolve_target");
  assert.equal(error.code, "provider_environment_not_found");
  assert.equal(error.failureClass, "permanent");
  assert.equal(error.phase, "resolve_target");
});

class RecordingContractAdapter extends ContractProviderAdapter {
  reconcileCalls = 0;

  override async reconcile(request: ExecutionReconcileRequest) {
    this.reconcileCalls += 1;
    return super.reconcile(request);
  }
}

function descriptorFor(
  id: string,
  resourceLimits: ProviderDescriptor["resourceLimits"] = {},
): ProviderDescriptor {
  return {
    descriptorVersion: 1,
    id,
    environmentKind: "container",
    workloadClass: "dedicated",
    accessMode: "direct_http",
    supportedArtifactKinds: ["oci-image"],
    supportedExecutionContracts: ["generic-v1"],
    supportedStorageClasses: ["workspace-data"],
    resourceLimits,
    capabilities: {
      rollback: "transactional",
      workloadHealth: "probe",
      metrics: true,
      diagnostics: true,
    },
  };
}

function reconcileRequest(overrides: Partial<ExecutionReconcileRequest> = {}): ExecutionReconcileRequest {
  const base = {
    workspaceId: "contract-workspace",
    ownerId: "contract-owner",
    providerId: "contract",
    appId: "plain-web",
    appRevisionId: "revision-1",
    launchArtifactId: "artifact-1",
    launchArtifactReference: "sha256:artifact",
    launchProfile: {
      imageReference: "sha256:artifact",
      resources: { memory: "2g", cpus: "1", pidsLimit: 256 },
      environment: {},
      configFiles: [],
    },
    storageBindings: [],
    desiredState: "running" as const,
    desiredGeneration: 1,
    transactionId: "transaction-1",
    replace: false,
  } satisfies ExecutionReconcileRequest;
  return { ...base, ...overrides };
}
