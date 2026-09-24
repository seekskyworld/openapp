import assert from "node:assert/strict";
import test from "node:test";
import {
  ContainerRuntimeExecutionEnvironment,
  GENERIC_EXECUTION_CONTRACT,
  type ContainerInstance,
  type ContainerRuntime,
} from "./index.js";

test("the neutral execution environment delegates lifecycle calls and preserves provider metadata", async () => {
  const calls: string[] = [];
  const instance: ContainerInstance = {
    instanceId: "workspace-1",
    ownerId: "owner-1",
    runtimeId: "environment-1",
    state: "running",
    endpoint: null,
    createdAt: new Date(0).toISOString(),
  };
  const runtime: ContainerRuntime = {
    async provision() { calls.push("provision"); return instance; },
    async get() { calls.push("get"); return instance; },
    async start() { calls.push("start"); return instance; },
    async stop() { calls.push("stop"); return instance; },
    async sampleActivity() { calls.push("metrics"); return { networkRxBytes: 0, networkTxBytes: 0, cpuPercent: 0, memoryWorkingSetBytes: 0, pids: 1 }; },
    async remove() { calls.push("remove"); },
  };
  const environment = new ContainerRuntimeExecutionEnvironment(runtime, {
    providerId: "story-provider",
    kind: "container",
    contract: GENERIC_EXECUTION_CONTRACT,
    accessMode: "provider_proxy",
  });

  assert.equal(environment.descriptor.providerId, "story-provider");
  assert.equal(environment.descriptor.contract, GENERIC_EXECUTION_CONTRACT);
  assert.equal((await environment.provision({ instanceId: "workspace-1", ownerId: "owner-1", imageReference: "story:1", launchProfile: {
    imageReference: "story:1",
    resources: { memory: "1g", cpus: "1", pidsLimit: 64 },
    environment: {},
    configFiles: [],
  } })).runtimeId, "environment-1");
  await environment.get("workspace-1");
  await environment.start("workspace-1");
  await environment.stop("workspace-1");
  await environment.sampleActivity("workspace-1");
  await environment.remove("workspace-1", "owner-1");
  assert.deepEqual(calls, ["provision", "get", "start", "stop", "metrics", "remove"]);
});

