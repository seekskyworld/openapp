import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateRuntimeProfile, type RuntimeProfile } from "./runtime-profile.js";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { promisify } from "node:util";

import {
  DockerCliRuntime,
  type DockerCliRuntimeConfig,
} from "./docker-cli-runtime.js";
import type {
  ContainerLaunchProfile,
  StorageBinding,
} from "./container-runtime.js";
const profilePath = process.env.OPENAPP_RUNTIME_ACCEPTANCE_PROFILE;
const acceptanceProfile: RuntimeProfile | undefined = profilePath ? JSON.parse(readFileSync(profilePath, "utf8")) : undefined;
if (acceptanceProfile) validateRuntimeProfile(acceptanceProfile);

const execFileAsync = promisify(execFile);
const acceptanceEnabled = process.env.OPENAPP_RUNTIME_ACCEPTANCE === "1";
const acceptanceImage = process.env.OPENAPP_RUNTIME_ACCEPTANCE_IMAGE?.trim() ?? "";
const probeImage = process.env.OPENAPP_RUNTIME_PROBE_IMAGE?.trim() || "node:24-bookworm-slim";
const SENTINEL_PATH = `${acceptanceProfile?.storageMountPath ?? "/data"}/.openapp-acceptance-sentinel`;
const HEALTH_PROBE = `fetch("http://127.0.0.1:${acceptanceProfile?.containerPort}${acceptanceProfile?.healthPath}",{signal:AbortSignal.timeout(2000)}).then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))`;

test("real Docker preserves a legacy deterministic Volume across start and deferred rebuild", {
  skip: acceptanceEnabled ? false : "OPENAPP_RUNTIME_ACCEPTANCE=1 is required",
  timeout: 180_000,
}, async (context) => {
  assert.ok(acceptanceImage, "OPENAPP_RUNTIME_ACCEPTANCE_IMAGE is required");
  assert.ok(acceptanceProfile, "OPENAPP_RUNTIME_ACCEPTANCE_PROFILE is required");
  assert.equal(
    await resourceExists(["image", "inspect", acceptanceImage]),
    true,
    `acceptance image is not available locally: ${acceptanceImage}`,
  );
  const runId = acceptanceRunId();
  const config = acceptanceConfig(acceptanceImage);
  const workspaceId = `accept-${runId}-legacy`;
  const ownerId = `accept-owner-${runId}-legacy`;
  const binding = workspaceBinding(config, workspaceId);
  const runtime = new DockerCliRuntime(config);
  context.after(() => cleanupWorkspace(config, workspaceId));
  await runtime.validateBuiltImage(acceptanceImage, acceptanceProfile.contract);

  await docker([
    "volume", "create",
    "--label", `${acceptanceProfile!.labelPrefix}.managed=true`,
    "--label", `${acceptanceProfile!.labelPrefix}.instance-id=${workspaceId}`,
    "--label", `${acceptanceProfile!.labelPrefix}.owner-id=${ownerId}`,
    binding.attachmentRef,
  ]);
  await runtime.provision({
    instanceId: workspaceId,
    ownerId,
    storageBindings: [binding],
    launchProfile: launchProfile(acceptanceImage),
  });
  await waitForHealthy(containerName(config, workspaceId));
  await writeSentinel(containerName(config, workspaceId), "legacy-sentinel");

  assert.equal((await runtime.stop(workspaceId)).state, "stopped");
  assert.equal((await runtime.start(workspaceId, undefined, [binding])).state, "running");
  await waitForHealthy(containerName(config, workspaceId));
  assert.equal(await readSentinel(containerName(config, workspaceId)), "legacy-sentinel");

  const rebuilt = await runtime.rebuild({
    instanceId: workspaceId,
    ownerId,
    start: false,
    rebuildTransactionId: `accept-${runId}-legacy-rebuild`,
    storageBindings: [binding],
    launchProfile: launchProfile(acceptanceImage, "1536m"),
  });
  assert.equal(rebuilt.state, "stopped");
  assert.equal((await runtime.start(workspaceId, undefined, [binding])).state, "running");
  await waitForHealthy(containerName(config, workspaceId));
  assert.equal(await readSentinel(containerName(config, workspaceId)), "legacy-sentinel");

  await assert.rejects(
    runtime.releaseWorkspaceStorage?.({ instanceId: workspaceId, ownerId, storageBindings: [binding] }),
    /matching ownership labels/u,
  );
  const labels = await volumeLabels(binding.attachmentRef);
  assert.equal(labels[`${acceptanceProfile!.labelPrefix}.storage-ref`], undefined);
  assert.equal(await resourceExists(["volume", "inspect", binding.attachmentRef]), true);
});

test("real Docker keeps Workspace data isolated through lifecycle and split deletion", {
  skip: acceptanceEnabled ? false : "OPENAPP_RUNTIME_ACCEPTANCE=1 is required",
  timeout: 240_000,
}, async (context) => {
  assert.ok(acceptanceImage, "OPENAPP_RUNTIME_ACCEPTANCE_IMAGE is required");
  assert.ok(acceptanceProfile, "OPENAPP_RUNTIME_ACCEPTANCE_PROFILE is required");
  assert.equal(
    await resourceExists(["image", "inspect", acceptanceImage]),
    true,
    `acceptance image is not available locally: ${acceptanceImage}`,
  );
  const runId = acceptanceRunId();
  const config = acceptanceConfig(acceptanceImage);
  const primaryId = `accept-${runId}-primary`;
  const otherId = `accept-${runId}-other`;
  const primaryOwner = `accept-owner-${runId}-primary`;
  const otherOwner = `accept-owner-${runId}-other`;
  const primaryBinding = workspaceBinding(config, primaryId);
  const otherBinding = workspaceBinding(config, otherId);
  const runtime = new DockerCliRuntime(config);
  context.after(async () => {
    await Promise.all([
      cleanupWorkspace(config, primaryId),
      cleanupWorkspace(config, otherId),
    ]);
  });

  await runtime.provision({
    instanceId: primaryId,
    ownerId: primaryOwner,
    storageBindings: [primaryBinding],
    launchProfile: launchProfile(acceptanceImage),
  });
  await waitForHealthy(containerName(config, primaryId));
  await writeSentinel(containerName(config, primaryId), "primary-sentinel");

  assert.equal((await runtime.stop(primaryId)).state, "stopped");
  assert.equal((await runtime.start(primaryId, undefined, [primaryBinding])).state, "running");
  await waitForHealthy(containerName(config, primaryId));
  assert.equal(await readSentinel(containerName(config, primaryId)), "primary-sentinel");

  const rebuilt = await runtime.rebuild({
    instanceId: primaryId,
    ownerId: primaryOwner,
    start: true,
    rebuildTransactionId: `accept-${runId}-policy-rebuild`,
    storageBindings: [primaryBinding],
    launchProfile: launchProfile(acceptanceImage, "1536m"),
  });
  assert.equal(rebuilt.state, "running");
  await waitForHealthy(containerName(config, primaryId));
  assert.equal(await readSentinel(containerName(config, primaryId)), "primary-sentinel");

  const restartedProvider = new DockerCliRuntime(config);
  assert.equal((await restartedProvider.get(primaryId, undefined, [primaryBinding]))?.state, "running");
  assert.equal(await readSentinel(containerName(config, primaryId)), "primary-sentinel");

  await runtime.provision({
    instanceId: otherId,
    ownerId: otherOwner,
    storageBindings: [otherBinding],
    launchProfile: launchProfile(acceptanceImage),
  });
  await waitForHealthy(containerName(config, otherId));
  await writeSentinel(containerName(config, otherId), "other-sentinel");

  await restartedProvider.removeEnvironment?.({
    instanceId: primaryId,
    ownerId: primaryOwner,
    storageBindings: [primaryBinding],
  });
  assert.equal(await resourceExists(["container", "inspect", containerName(config, primaryId)]), false);
  assert.equal(await resourceExists(["network", "inspect", networkName(config, primaryId)]), false);
  assert.equal(await resourceExists(["network", "inspect", egressNetworkName(config, primaryId)]), false);
  assert.equal(await resourceExists(["volume", "inspect", primaryBinding.attachmentRef]), true);
  assert.equal(await readVolumeSentinel(acceptanceImage, primaryBinding.attachmentRef), "primary-sentinel");

  await restartedProvider.provision({
    instanceId: primaryId,
    ownerId: primaryOwner,
    storageBindings: [primaryBinding],
    launchProfile: launchProfile(acceptanceImage),
  });
  await waitForHealthy(containerName(config, primaryId));
  assert.equal(await readSentinel(containerName(config, primaryId)), "primary-sentinel");

  await restartedProvider.removeEnvironment?.({
    instanceId: primaryId,
    ownerId: primaryOwner,
    storageBindings: [primaryBinding],
  });
  await restartedProvider.releaseWorkspaceStorage?.({
    instanceId: primaryId,
    ownerId: primaryOwner,
    storageBindings: [primaryBinding],
  });
  await restartedProvider.releaseWorkspaceStorage?.({
    instanceId: primaryId,
    ownerId: primaryOwner,
    storageBindings: [primaryBinding],
  });
  assert.equal(await resourceExists(["volume", "inspect", primaryBinding.attachmentRef]), false);
  assert.equal(await readSentinel(containerName(config, otherId)), "other-sentinel");
  assert.equal(await resourceExists(["volume", "inspect", otherBinding.attachmentRef]), true);
});

function acceptanceRunId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function acceptanceConfig(image: string): DockerCliRuntimeConfig {
  const targetPlatform = process.env.TARGET_PLATFORM === "linux/amd64"
    ? "linux/amd64"
    : process.env.TARGET_PLATFORM === "linux/arm64" || process.arch === "arm64"
      ? "linux/arm64"
      : "linux/amd64";
  return {
    binary: "docker",
    probeImage,
    image,
    networkPrefix: "oa-accept-net-",
    networkPoolCidr: "10.240.0.0/12",
    networkSubnetPrefix: 28,
    endpointMode: "loopback",
    namePrefix: "oa-accept-user-",
    volumePrefix: "oa-accept-data-",
    authProviderBaseUrl: process.env.OPENAPP_AUTH_PROVIDER_BASE_URL ?? "http://127.0.0.1",
    allowedOrigins: "http://127.0.0.1",
    memory: "2g",
    cpus: "1",
    pidsLimit: 256,
    targetPlatform,
    profile: acceptanceProfile!,
  };
}

function workspaceBinding(config: DockerCliRuntimeConfig, workspaceId: string): StorageBinding {
  return {
    storageId: `workspace-storage:${workspaceId}`,
    attachmentRef: `${config.volumePrefix}${workspaceId}`,
    mountPath: config.profile?.storageMountPath ?? "/data",
    readOnly: false,
  };
}

function launchProfile(image: string, memory = "2g"): ContainerLaunchProfile {
  return {
    imageReference: image,
    resources: { memory, cpus: "1", pidsLimit: 256 },
    environment: {},
    configFiles: [],
  };
}

function containerName(config: DockerCliRuntimeConfig, workspaceId: string): string {
  return `${config.namePrefix}${workspaceId}`;
}

function networkName(config: DockerCliRuntimeConfig, workspaceId: string): string {
  return `${config.networkPrefix}${workspaceId}`;
}

function egressNetworkName(config: DockerCliRuntimeConfig, workspaceId: string): string {
  return `${networkName(config, workspaceId)}-egress`;
}

async function waitForHealthy(name: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await docker(["run", "--rm", "--network", `container:${name}`, "--read-only",
        "--cap-drop", "ALL", "--entrypoint", "node", probeImage, "-e", HEALTH_PROBE]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`acceptance container did not become healthy: ${name}`, { cause: lastError });
}

async function writeSentinel(name: string, value: string): Promise<void> {
  const encoded = Buffer.from(value, "utf8").toString("base64");
  await docker([
    "run", "--rm", "--network", "none", "--read-only", "--volumes-from", `${name}:rw`,
    "--entrypoint", "node", probeImage, "-e",
    'require("node:fs").writeFileSync(process.argv[1],Buffer.from(process.argv[2],"base64"))',
    SENTINEL_PATH, encoded,
  ]);
}

async function readSentinel(name: string): Promise<string> {
  const result = await docker([
    "run", "--rm", "--network", "none", "--read-only", "--volumes-from", `${name}:ro`,
    "--entrypoint", "node", probeImage, "-e",
    'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', SENTINEL_PATH,
  ]);
  return result.stdout;
}

async function readVolumeSentinel(_image: string, volumeName: string): Promise<string> {
  const result = await docker([
    "run", "--rm", "--network", "none", "--read-only",
    "--mount", `type=volume,source=${volumeName},target=${acceptanceProfile!.storageMountPath},readonly`,
    "--entrypoint", "node", probeImage, "-e",
    'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8"))', SENTINEL_PATH,
  ]);
  return result.stdout;
}

async function volumeLabels(name: string): Promise<Record<string, string>> {
  const inspected = JSON.parse((await docker(["volume", "inspect", name])).stdout) as Array<{
    Labels?: Record<string, string>;
  }>;
  return inspected[0]?.Labels ?? {};
}

async function cleanupWorkspace(config: DockerCliRuntimeConfig, workspaceId: string): Promise<void> {
  const canonical = containerName(config, workspaceId);
  const containers = [
    canonical,
    `${canonical}-rebuild-next`,
    `${canonical}-rebuild-previous`,
    `${canonical}-rebuild-rollback`,
  ];
  for (const name of containers) await removeIfPresent(["rm", "--force", name]);
  await removeIfPresent(["network", "rm", networkName(config, workspaceId)]);
  await removeIfPresent(["network", "rm", egressNetworkName(config, workspaceId)]);
  await removeIfPresent(["volume", "rm", `${config.volumePrefix}${workspaceId}`]);
}

async function resourceExists(args: string[]): Promise<boolean> {
  try {
    await docker(args);
    return true;
  } catch (error) {
    if (isMissingResource(error)) return false;
    throw error;
  }
}

async function removeIfPresent(args: string[]): Promise<void> {
  try {
    await docker(args);
  } catch (error) {
    if (!isMissingResource(error)) throw error;
  }
}

function isMissingResource(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("stderr" in error)) return false;
  const stderr = String((error as { stderr?: unknown }).stderr ?? "");
  return /No such (?:container|image|network|volume|object)|not found/iu.test(stderr);
}

async function docker(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("docker", args, { maxBuffer: 10 * 1024 * 1024 });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}
