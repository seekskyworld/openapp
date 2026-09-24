import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

import {
  DockerCliRuntime,
  dockerCliRuntimeConfigFromEnv,
  type CommandRunner,
  type DockerCliRuntimeConfig,
} from "./docker-cli-runtime.js";
import {
  ContainerArtifactValidationError,
  ContainerRebuildRollbackError,
  NO_RUNTIME_CONTRACT,
  type ContainerRuntime,
} from "./container-runtime.js";
import {
  LEGACY_RUNTIME_PROFILE_FIXTURE,
  SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE,
} from "./testing/sample-profile.js";

const config: DockerCliRuntimeConfig = {
  binary: "docker",
  image: "sample-app-runtime:test",
  networkPrefix: "test-net-",
  networkPoolCidr: "10.240.0.0/12",
  networkSubnetPrefix: 28,
  endpointMode: "loopback",
  namePrefix: "test-user-",
  volumePrefix: "test-data-",
  authProviderBaseUrl: "https://identity.example.test",
  allowedOrigins: "https://portal.example.test",
  mcpAppSandboxOrigin: "https://openapp-mcp.example.test",
  memory: "1g",
  cpus: "1",
  pidsLimit: 128,
  targetPlatform: "linux/amd64",
  // 这些 fixture 模拟迁移前的 SampleApp 资源；生产通用 Runtime 不会隐式使用此 profile。
  profile: LEGACY_RUNTIME_PROFILE_FIXTURE,
};

function isHealthProbe(args: readonly string[]): boolean {
  return args[0] === "run" && args.some(value => value.startsWith("container:")) && args.includes("--entrypoint") && args.includes("node");
}

function inspect(
  instanceId: string,
  ownerId: string,
  status = "running",
  options: { id?: string; hostname?: string; labels?: Record<string, string> } = {},
): string {
  return JSON.stringify([
    {
      Id: options.id ?? "1290c0ae578d0000000000000000000000000000000000000000000000000000",
      Created: "2026-07-15T00:00:00.000Z",
      Config: {
        ...(options.hostname ? { Hostname: options.hostname } : {}),
        Labels: {
          "io.sample-app.portal.managed": "true",
          "io.sample-app.portal.instance-id": instanceId,
          "io.sample-app.portal.owner-id": ownerId,
          ...options.labels,
        },
      },
      State: { Status: status },
      NetworkSettings: {
        Ports: {
          "37371/tcp": [{ HostIp: "127.0.0.1", HostPort: "49152" }],
        },
      },
    },
  ]);
}

function managedResource(name: string, instanceId: string, ownerId: string): string {
  return JSON.stringify([{
    Name: name,
    ...(name.startsWith("test-net-") ? {
      Internal: !name.endsWith("-egress"),
      Options: name.endsWith("-egress")
        ? { "com.docker.network.bridge.enable_icc": "false" }
        : {},
    } : {}),
    Labels: {
      "io.sample-app.portal.managed": "true",
      "io.sample-app.portal.instance-id": instanceId,
      "io.sample-app.portal.owner-id": ownerId,
      ...(name.includes("data") ? {
        "io.sample-app.portal.storage-ref": `workspace-storage:${instanceId}`,
      } : {}),
    },
  }]);
}

function storageBinding(instanceId: string, attachmentRef = `test-data-${instanceId}`) {
  return {
    storageId: `workspace-storage:${instanceId}`,
    attachmentRef,
    mountPath: "/var/lib/sample-app",
    readOnly: false,
  };
}

function isContainerInspect(args: readonly string[]): boolean {
  return args[0] === "container" && args[1] === "inspect";
}

function labelValues(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] !== "--label") continue;
    const [key, ...value] = String(args[index + 1]).split("=");
    if (key) labels[key] = value.join("=");
  }
  return labels;
}

function rebuildLabels(
  transactionId: string,
  predecessorId: string,
  startRequested: boolean,
): Record<string, string> {
  return {
    "io.sample-app.portal.rebuild-id": transactionId,
    "io.sample-app.portal.rebuild-predecessor-id": predecessorId,
    "io.sample-app.portal.rebuild-role": "candidate",
    "io.sample-app.portal.rebuild-start-requested": String(startRequested),
  };
}

function runtimeWithRebuildArtifacts(
  artifacts: Readonly<Record<string, string>>,
  calls: string[][] = [],
): ContainerRuntime {
  return new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (!isContainerInspect(args)) throw new Error("rebuild inspection must be read-only");
    const artifact = artifacts[String(args[2])];
    if (!artifact) throw new Error("No such container");
    return { stdout: artifact, stderr: "" };
  });
}

test("default Docker runner redacts argv and launch-profile secrets from failures", async (t) => {
  const fakeBinDirectory = await mkdtemp(join(tmpdir(), "openapp-docker-runner-"));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(fakeBinDirectory, { recursive: true, force: true });
  });
  await writeFile(join(fakeBinDirectory, "docker"), `#!/bin/sh
case "$1:$2" in
  container:inspect)
    printf '%s\n' 'Error response from daemon: No such container' >&2
    exit 1
    ;;
  volume:inspect)
    printf '%s\n' 'Error response from daemon: No such volume' >&2
    exit 1
    ;;
  network:inspect)
    printf '%s\n' 'Error response from daemon: No such network' >&2
    exit 1
    ;;
  volume:create|network:create)
    printf '%s\n' 'created'
    exit 0
    ;;
  create:*)
    printf 'permission denied while processing: %s\n' "$*" >&2
    exit 19
    ;;
esac
exit 97
`, { mode: 0o700 });
  process.env.PATH = `${fakeBinDirectory}${delimiter}${originalPath ?? ""}`;

  const privateKeyBody = "TEST_PRIVATE_KEY_BODY";
  const privateKey = [
    "-----BEGIN PRIVATE KEY-----",
    privateKeyBody,
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const databaseUrl = "postgres://portal:database-secret@db.internal/openapp";
  const configContent = JSON.stringify({ signingKey: privateKey, token: "config-file-secret" });
  const runtime = new DockerCliRuntime(config);
  const failure = await runtime.provision({
    instanceId: "inst_redaction",
    ownerId: "user_redaction",
    start: false,
    launchProfile: {
      imageReference: "sample-app-runtime:test",
      resources: { memory: "1g", cpus: "1", pidsLimit: 128 },
      environment: { DATABASE_URL: databaseUrl },
      configFiles: [{ path: "keys/service.json", content: configContent }],
    },
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof Error);
  assert.equal(failure.message, "Docker create failed (exit code 19; permission denied)");
  for (const sensitiveText of [
    "--env",
    "DATABASE_URL",
    databaseUrl,
    "SAMPLE_APP_CONFIG_FILES_JSON",
    configContent,
    privateKeyBody,
    privateKey,
  ]) {
    assert.equal(failure.message.includes(sensitiveText), false, `leaked ${sensitiveText}`);
  }
});

test("default Docker runner preserves the AbortSignal reason", async (t) => {
  const fakeBinDirectory = await mkdtemp(join(tmpdir(), "openapp-docker-abort-"));
  const originalPath = process.env.PATH;
  t.after(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    await rm(fakeBinDirectory, { recursive: true, force: true });
  });
  await writeFile(join(fakeBinDirectory, "docker"), `#!/bin/sh
exec sleep 5
`, { mode: 0o700 });
  process.env.PATH = `${fakeBinDirectory}${delimiter}${originalPath ?? ""}`;

  const controller = new AbortController();
  const abortReason = new Error("rollout lease lost");
  const pending = new DockerCliRuntime(config).provision({
    instanceId: "inst_aborted_runner",
    ownerId: "user_aborted_runner",
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(abortReason), 25);

  await assert.rejects(pending, (error: unknown) => error === abortReason);
});

test("public lifecycle methods forward AbortSignal to Docker commands", async () => {
  const operations: Array<{
    name: string;
    run: (runtime: DockerCliRuntime, signal: AbortSignal) => Promise<unknown>;
  }> = [
    { name: "get", run: (runtime, signal) => runtime.get("inst_signal_get", signal) },
    { name: "start", run: (runtime, signal) => runtime.start("inst_signal_start", signal) },
    { name: "stop", run: (runtime, signal) => runtime.stop("inst_signal_stop", signal) },
    { name: "remove", run: (runtime, signal) => runtime.remove("inst_signal_remove", "user_signal", signal) },
  ];

  for (const operation of operations) {
    const controller = new AbortController();
    const observedSignals: Array<AbortSignal | undefined> = [];
    const runtime = new DockerCliRuntime(config, async (_binary, _args, options) => {
      observedSignals.push(options?.signal);
      throw new Error(`signal_probe_${operation.name}`);
    });

    await assert.rejects(operation.run(runtime, controller.signal), new RegExp(`signal_probe_${operation.name}`, "u"));
    assert.ok(observedSignals.length > 0, `${operation.name} must issue a Docker command`);
    assert.ok(
      observedSignals.every((signal) => signal === controller.signal),
      `${operation.name} must preserve the caller AbortSignal`,
    );
  }
});

test("provision preserves AbortSignal when starting an existing stopped container", async () => {
  const instanceId = "inst_signal_existing";
  const ownerId = "user_signal_existing";
  const canonicalName = `test-user-${instanceId}`;
  const controller = new AbortController();
  const observed: Array<{ args: string[]; signal: AbortSignal | undefined }> = [];
  let status = "exited";
  const runtime = new DockerCliRuntime(config, async (_binary, args, options) => {
    observed.push({ args: [...args], signal: options?.signal });
    if (isContainerInspect(args)) {
      if (args[2] === canonicalName) {
        return { stdout: inspect(instanceId, ownerId, status), stderr: "" };
      }
      throw new Error("No such container");
    }
    if (args[0] === "start" && args[1] === canonicalName) {
      status = "running";
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  });

  const provisioned = await runtime.provision({ instanceId, ownerId, signal: controller.signal });

  assert.equal(provisioned.state, "running");
  assert.ok(observed.length > 0);
  assert.deepEqual(
    observed.filter((call) => call.signal !== controller.signal).map((call) => call.args),
    [],
  );
});

test("network endpoint configuration requires a Portal container and isolated network prefix", () => {
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ CONTAINER_RUNTIME_ENDPOINT_MODE: "network" }, {
      compatibilityMode: true,
      profile: LEGACY_RUNTIME_PROFILE_FIXTURE,
    }),
    /SAMPLE_APP_PORTAL_CONTAINER is required/u,
  );
  const loaded = dockerCliRuntimeConfigFromEnv({
    CONTAINER_RUNTIME_ENDPOINT_MODE: "network",
    SAMPLE_APP_PORTAL_CONTAINER: "portal-control-plane",
    SAMPLE_APP_NETWORK_NAME_PREFIX: "tenant-net-",
  }, { compatibilityMode: true, profile: LEGACY_RUNTIME_PROFILE_FIXTURE });
  assert.equal(loaded.portalContainer, "portal-control-plane");
  assert.equal(loaded.networkPrefix, "tenant-net-");
  assert.equal(loaded.networkPoolCidr, "10.240.0.0/12");
  assert.equal(loaded.networkSubnetPrefix, 28);
  assert.equal(
    dockerCliRuntimeConfigFromEnv({ MCP_APP_SANDBOX_ORIGIN: "https://openapp-mcp.example.test" }).mcpAppSandboxOrigin,
    "https://openapp-mcp.example.test",
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ SAMPLE_APP_NETWORK_NAME_PREFIX: "bad/name" }, {
      compatibilityMode: true,
      profile: LEGACY_RUNTIME_PROFILE_FIXTURE,
    }),
    /SAMPLE_APP_NETWORK_NAME_PREFIX contains unsupported characters/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ SAMPLE_APP_CONTAINER_PIDS_LIMIT: "512oops" }, {
      compatibilityMode: true,
      profile: LEGACY_RUNTIME_PROFILE_FIXTURE,
    }),
    /SAMPLE_APP_CONTAINER_PIDS_LIMIT must be an integer/u,
  );
  assert.equal(dockerCliRuntimeConfigFromEnv({ TARGET_PLATFORM: "linux/arm64" }).targetPlatform, "linux/arm64");
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ TARGET_PLATFORM: "darwin/arm64" }),
    /TARGET_PLATFORM must be linux\/amd64 or linux\/arm64/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ SAMPLE_APP_NETWORK_POOL_CIDR: "10.240.1.0/12" }, {
      compatibilityMode: true,
      profile: LEGACY_RUNTIME_PROFILE_FIXTURE,
    }),
    /SAMPLE_APP_NETWORK_POOL_CIDR must be an aligned private IPv4 CIDR/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ SAMPLE_APP_NETWORK_POOL_CIDR: "8.0.0.0/12" }, {
      compatibilityMode: true,
      profile: LEGACY_RUNTIME_PROFILE_FIXTURE,
    }),
    /SAMPLE_APP_NETWORK_POOL_CIDR must be an aligned private IPv4 CIDR/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ SAMPLE_APP_NETWORK_SUBNET_PREFIX: "12" }, {
      compatibilityMode: true,
      profile: LEGACY_RUNTIME_PROFILE_FIXTURE,
    }),
    /SAMPLE_APP_NETWORK_SUBNET_PREFIX must be an integer between 13 and 29/u,
  );
});

test("generic Runtime settings take precedence over legacy SampleApp aliases", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    OPENAPP_AUTH_PROVIDER_BASE_URL: " https://identity.example.test ",
    AUTH_PROVIDER_BASE_URL: "https://identity-alias.example.test",
    SAMPLE_APP_AUTH_BASE_URL: "https://legacy.example.test",
    OPENAPP_CONTAINER_MEMORY: " 3g ",
    SAMPLE_APP_CONTAINER_MEMORY: "1g",
    OPENAPP_CONTAINER_CPUS: " 3.5 ",
    SAMPLE_APP_CONTAINER_CPUS: "1",
    OPENAPP_CONTAINER_PIDS_LIMIT: " 1024 ",
    SAMPLE_APP_CONTAINER_PIDS_LIMIT: "128",
  });

  assert.equal(loaded.authProviderBaseUrl, "https://identity.example.test");
  assert.equal(loaded.memory, "3g");
  assert.equal(loaded.cpus, "3.5");
  assert.equal(loaded.pidsLimit, 1024);
});

test("blank generic Runtime settings keep neutral defaults and ignore legacy aliases", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    OPENAPP_AUTH_PROVIDER_BASE_URL: "  ",
    AUTH_PROVIDER_BASE_URL: " https://identity-alias.example.test ",
    SAMPLE_APP_AUTH_BASE_URL: "https://legacy.example.test",
    OPENAPP_CONTAINER_MEMORY: " ",
    SAMPLE_APP_CONTAINER_MEMORY: "2g",
    OPENAPP_CONTAINER_CPUS: "",
    SAMPLE_APP_CONTAINER_CPUS: "1.5",
    OPENAPP_CONTAINER_PIDS_LIMIT: "\t",
    SAMPLE_APP_CONTAINER_PIDS_LIMIT: "256",
  });

  assert.equal(loaded.authProviderBaseUrl, "https://identity-alias.example.test");
  assert.equal(loaded.memory, "4g");
  assert.equal(loaded.cpus, "2");
  assert.equal(loaded.pidsLimit, 512);
});

test("explicit generic Runtime mode ignores legacy SampleApp aliases", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    SAMPLE_APP_AUTH_BASE_URL: "https://legacy.example.test",
    SAMPLE_APP_CONTAINER_IMAGE: "legacy-runtime:1",
    SAMPLE_APP_NETWORK_NAME_PREFIX: "legacy-net-",
    SAMPLE_APP_CONTAINER_MEMORY: "1g",
    SAMPLE_APP_CONTAINER_CPUS: "1",
    SAMPLE_APP_CONTAINER_PIDS_LIMIT: "64",
    OPENAPP_RUNTIME_IMAGE: "generic-runtime:1",
  }, { compatibilityMode: false });

  assert.equal(loaded.profile?.id, "generic");
  assert.equal(loaded.image, "generic-runtime:1");
  assert.equal(loaded.networkPrefix, "openapp-net-");
  assert.equal(loaded.memory, "4g");
  assert.equal(loaded.cpus, "2");
  assert.equal(loaded.pidsLimit, 512);
  assert.equal(loaded.authProviderBaseUrl, undefined);
  assert.equal(loaded.authProviderBaseUrl, undefined);
  assert.deepEqual(loaded.runtimeEnvironment, {});
});

test("generic Runtime does not select a legacy image alias when the generic image is absent", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    OPENAPP_CONTAINER_IMAGE: "legacy-runtime:1",
  }, { compatibilityMode: false });

  assert.equal(loaded.image, "openapp-runtime:0.1.0");
});

test("legacy Runtime can still select the historical image alias", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    OPENAPP_CONTAINER_IMAGE: "legacy-runtime:1",
  }, { compatibilityMode: true, profile: LEGACY_RUNTIME_PROFILE_FIXTURE });

  assert.equal(loaded.image, "legacy-runtime:1");
});

test("explicit legacy Runtime mode preserves old aliases", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    SAMPLE_APP_AUTH_BASE_URL: "https://legacy.example.test",
    SAMPLE_APP_CONTAINER_MEMORY: "2g",
    SAMPLE_APP_CONTAINER_CPUS: "1.5",
    SAMPLE_APP_CONTAINER_PIDS_LIMIT: "256",
  }, { compatibilityMode: true, profile: LEGACY_RUNTIME_PROFILE_FIXTURE });

  assert.equal(loaded.profile?.id, "sample-app-legacy");
  assert.equal(loaded.authProviderBaseUrl, "https://legacy.example.test");
  assert.equal(loaded.authProviderBaseUrl, "https://legacy.example.test");
  assert.equal(loaded.memory, "2g");
  assert.equal(loaded.cpus, "1.5");
  assert.equal(loaded.pidsLimit, 256);
  assert.equal(loaded.runtimeEnvironment?.SAMPLE_APP_AUTH_BASE_URL, "https://legacy.example.test");
});

test("generic Runtime validation errors use neutral variable names", () => {
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ OPENAPP_NETWORK_NAME_PREFIX: "bad/name" }, { compatibilityMode: false }),
    /OPENAPP_NETWORK_NAME_PREFIX contains unsupported characters/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({ OPENAPP_CONTAINER_PIDS_LIMIT: "bad" }, { compatibilityMode: false }),
    /OPENAPP_CONTAINER_PIDS_LIMIT must be an integer/u,
  );
});

test("generic Runtime ignores malformed legacy-only settings without selecting SampleApp", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    SAMPLE_APP_NETWORK_NAME_PREFIX: "bad/name",
    SAMPLE_APP_CONTAINER_PIDS_LIMIT: "not-a-number",
  });
  assert.equal(loaded.profile?.id, "generic");
  assert.equal(loaded.networkPrefix, "openapp-net-");
  assert.equal(loaded.pidsLimit, 512);
  assert.deepEqual(loaded.runtimeEnvironment, {});
});

test("runtime environment JSON accepts adapter keys while preserving injected Provider values", () => {
  const loaded = dockerCliRuntimeConfigFromEnv({
    OPENAPP_RUNTIME_ENVIRONMENT_JSON: JSON.stringify({ FEATURE_FLAG: "enabled" }),
    OPENAPP_AUTH_PROVIDER_BASE_URL: "https://identity.example.test",
  }, { compatibilityMode: true, profile: LEGACY_RUNTIME_PROFILE_FIXTURE });

  assert.equal(loaded.runtimeEnvironment?.FEATURE_FLAG, "enabled");
  assert.equal(loaded.runtimeEnvironment?.SAMPLE_APP_AUTH_BASE_URL, "https://identity.example.test");
});

test("runtime environment JSON rejects Core and profile-reserved keys", () => {
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({
      OPENAPP_RUNTIME_ENVIRONMENT_JSON: JSON.stringify({ OPENAPP_CONFIG_FILES_JSON: "/tmp/override" }),
    }),
    /OPENAPP_RUNTIME_ENVIRONMENT_JSON key is reserved/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({
      OPENAPP_RUNTIME_ENVIRONMENT_JSON: JSON.stringify({ SAMPLE_APP_AUTH_BASE_URL: "https://attacker.invalid" }),
    }, { compatibilityMode: true, profile: LEGACY_RUNTIME_PROFILE_FIXTURE }),
    /OPENAPP_RUNTIME_ENVIRONMENT_JSON key is reserved/u,
  );
});

test("runtime environment JSON rejects unsafe names, control bytes and oversized values", () => {
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({
      OPENAPP_RUNTIME_ENVIRONMENT_JSON: JSON.stringify({ "BAD-NAME": "value" }),
    }),
    /OPENAPP_RUNTIME_ENVIRONMENT_JSON key is invalid/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({
      OPENAPP_RUNTIME_ENVIRONMENT_JSON: JSON.stringify({ SAFE_NAME: "line\nvalue" }),
    }),
    /OPENAPP_RUNTIME_ENVIRONMENT_JSON value is invalid/u,
  );
  assert.throws(
    () => dockerCliRuntimeConfigFromEnv({
      OPENAPP_RUNTIME_ENVIRONMENT_JSON: JSON.stringify({ SAFE_NAME: "x".repeat(16 * 1024 + 1) }),
    }),
    /OPENAPP_RUNTIME_ENVIRONMENT_JSON value is too large/u,
  );
});

test("explicit Runtime environment cannot inject reserved keys", () => {
  assert.throws(
    () => new DockerCliRuntime({
      ...config,
      runtimeEnvironment: { OPENAPP_CONFIG_FILES_JSON: "/tmp/override" },
    }),
    /runtime environment key is reserved/u,
  );
});

test("explicit Runtime environment cannot override a Provider-injected key", () => {
  assert.throws(
    () => new DockerCliRuntime({
      ...config,
      runtimeEnvironment: { SAMPLE_APP_AUTH_BASE_URL: "https://attacker.invalid" },
    }),
    /runtime environment key is reserved: SAMPLE_APP_AUTH_BASE_URL/u,
  );
});

test("runtime status reports the selected Docker-compatible engine", async () => {
  const loaded = dockerCliRuntimeConfigFromEnv({ CONTAINER_RUNTIME: "orbstack" });
  const runtime = new DockerCliRuntime(loaded, async () => ({ stdout: "29.4.0\n", stderr: "" }));

  assert.deepEqual(await runtime.status(), { runtime: "orbstack", available: true, version: "29.4.0" });
});

test("Docker resolves a stable Workspace storage identity to one named Volume attachment", async () => {
  const runtime = new DockerCliRuntime(config, async () => {
    throw new Error("storage resolution must not call Docker");
  });

  assert.deepEqual(await runtime.resolveStorageBinding({
    workspaceId: "inst_storage_resolution",
    ownerId: "user_storage_resolution",
    storageId: "workspace-storage:inst_storage_resolution",
    storageClass: "workspace-data",
    affinityProviderId: "docker",
  }), {
    storageId: "workspace-storage:inst_storage_resolution",
    attachmentRef: "test-data-inst_storage_resolution",
    mountPath: "/var/lib/sample-app",
    readOnly: false,
  });
  await assert.rejects(runtime.resolveStorageBinding({
    workspaceId: "inst_storage_resolution",
    ownerId: "user_storage_resolution",
    storageId: "workspace-storage:another-workspace",
    storageClass: "workspace-data",
  }), /workspace storage identity mismatch/u);
});

test("image listing includes both tags and repository digests", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    return {
      stdout: `registry.example.test/openapp v1 ${digest} sha256:image-id 42MB\nregistry.example.test/untagged <none> <none> sha256:image-id 42MB\n`,
      stderr: "",
    };
  });

  assert.deepEqual(await runtime.listImages(), [
    { reference: "registry.example.test/openapp:v1", id: "sha256:image-id", size: "42MB" },
    { reference: `registry.example.test/openapp@${digest}`, id: "sha256:image-id", size: "42MB" },
  ]);
  assert.deepEqual(calls, [[
    "images",
    "--digests",
    "--no-trunc",
    "--filter",
    "dangling=false",
    "--format",
    "{{.Repository}} {{.Tag}} {{.Digest}} {{.ID}} {{.Size}}",
  ]]);
});

test("image resolution keeps a dangling immutable id launchable after a tag moves", async () => {
  const oldImageId = `sha256:${"a".repeat(64)}`;
  const newImageId = `sha256:${"b".repeat(64)}`;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    assert.deepEqual(args, ["image", "inspect", "--format", "{{.Id}}", oldImageId]);
    return { stdout: `${oldImageId}\n`, stderr: "" };
  });

  assert.equal(await runtime.resolveImage(oldImageId), oldImageId);
  assert.notEqual(await runtime.resolveImage(oldImageId), newImageId);
});

test("image resolution distinguishes an absent image from a runtime failure", async () => {
  const missing = new DockerCliRuntime(config, async () => { throw new Error("No such image: missing:1"); });
  assert.equal(await missing.resolveImage("missing:1"), null);

  const unavailable = new DockerCliRuntime(config, async () => { throw new Error("daemon unavailable"); });
  await assert.rejects(unavailable.resolveImage("missing:1"), /daemon unavailable/u);
});

test("image validation selects a startup contract independently from the App id", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    return {
      stdout: JSON.stringify({
        Entrypoint: ["/opt/sample-app/start.sh"],
        Cmd: ["web", "--host", "0.0.0.0", "--port", "37371"],
        User: "sample-app",
        ExposedPorts: { "37371/tcp": {} },
      }),
      stderr: "",
    };
  });

  await runtime.validateImage("generic-runtime:1", SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE);
  await runtime.validateImage("unchecked-runtime:1", NO_RUNTIME_CONTRACT);
  await assert.rejects(
    runtime.validateImage("generic-runtime:1", "unknown-v1"),
    (error: unknown) => error instanceof ContainerArtifactValidationError
      && error.code === "runtime_image_contract_unsupported"
      && error.failure === "unsupported",
  );
  assert.deepEqual(calls, [["image", "inspect", "--format", "{{json .Config}}", "generic-runtime:1"]]);

  const misleadingCommand = new DockerCliRuntime(config, async () => ({
    stdout: JSON.stringify({
      Entrypoint: ["/opt/sample-app/start.sh"],
      Cmd: ["not-web", "--host", "0.0.0.0", "--port", "137371"],
      User: "sample-app",
      ExposedPorts: { "37371/tcp": {} },
    }),
    stderr: "",
  }));
  await assert.rejects(
    misleadingCommand.validateImage("generic-runtime:1", SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE),
    (error: unknown) => error instanceof ContainerArtifactValidationError
      && error.code === "runtime_image_contract_invalid"
      && error.failure === "invalid",
  );
});

test("built image validation checks platform, starts with production security, probes health, and cleans up", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "image" && args[3] === "{{json .Config}}") {
      return {
        stdout: JSON.stringify({
          Entrypoint: ["/opt/sample-app/start.sh"],
          Cmd: ["web", "--host", "0.0.0.0", "--port", "37371"],
          User: "sample-app",
          ExposedPorts: { "37371/tcp": {} },
        }),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[3] === "{{.Os}}/{{.Architecture}}") {
      return { stdout: "linux/amd64\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  }, () => "smoke-test");

  await runtime.validateBuiltImage("sample-app-runtime:built", SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE);
  assert.ok(calls.some(args => isHealthProbe(args) && args.includes("container:openapp-image-smoke-smoke-test") && args.includes("node:24-bookworm-slim")));
  assert.deepEqual(calls.filter(args => !isHealthProbe(args) && !(args[0] === "rm" && args.at(-1)?.startsWith("openapp-health-probe-"))), [
    ["image", "inspect", "--format", "{{json .Config}}", "sample-app-runtime:built"],
    ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", "sample-app-runtime:built"],
    [
      "run", "--detach", "--name", "openapp-image-smoke-smoke-test",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--restart", "no",
      "--mount", "type=volume,destination=/var/lib/sample-app",
      "--env", "SAMPLE_APP_AUTH_BASE_URL=https://identity.example.test",
      "--env", "SAMPLE_APP_BRIDGE_ALLOWED_ORIGINS=https://portal.example.test",
      "--env", "SAMPLE_APP_MCP_APP_SANDBOX_ORIGIN=https://openapp-mcp.example.test",
      "sample-app-runtime:built",
    ],
    ["rm", "--force", "--volumes", "openapp-image-smoke-smoke-test"],
  ]);
});

test("built image validation always removes a failed smoke container", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "image" && args[3] === "{{json .Config}}") {
      return {
        stdout: JSON.stringify({
          Entrypoint: ["/opt/sample-app/start.sh"],
          Cmd: ["web", "--host", "0.0.0.0", "--port", "37371"],
          User: "sample-app",
          ExposedPorts: { "37371/tcp": {} },
        }),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[3] === "{{.Os}}/{{.Architecture}}") return { stdout: "linux/amd64\n", stderr: "" };
    if (isHealthProbe(args)) throw new Error("health probe failed");
    return { stdout: "", stderr: "" };
  }, () => "smoke-failure");

  await assert.rejects(
    runtime.validateBuiltImage("sample-app-runtime:built", SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE),
    /health probe failed/u,
  );
  assert.deepEqual(calls.at(-1), ["rm", "--force", "--volumes", "openapp-image-smoke-smoke-failure"]);
});

test("built image validation preserves a container-create failure", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "image" && args[3] === "{{json .Config}}") {
      return {
        stdout: JSON.stringify({
          Entrypoint: ["/opt/sample-app/start.sh"],
          Cmd: ["web", "--host", "0.0.0.0", "--port", "37371"],
          User: "sample-app",
          ExposedPorts: { "37371/tcp": {} },
        }),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[3] === "{{.Os}}/{{.Architecture}}") {
      return { stdout: "linux/amd64\n", stderr: "" };
    }
    if (args[0] === "run") throw new Error("container create failed");
    return { stdout: "", stderr: "" };
  }, () => "smoke-create-failure");

  await assert.rejects(
    runtime.validateBuiltImage("sample-app-runtime:built", SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE),
    /container create failed/u,
  );
  assert.equal(calls.some((args) => args[0] === "rm"), false);
});

test("built image validation fails when its smoke container cannot be removed", async () => {
  let cleanupAttempts = 0;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    if (args[0] === "image" && args[3] === "{{json .Config}}") {
      return {
        stdout: JSON.stringify({
          Entrypoint: ["/opt/sample-app/start.sh"],
          Cmd: ["web", "--host", "0.0.0.0", "--port", "37371"],
          User: "sample-app",
          ExposedPorts: { "37371/tcp": {} },
        }),
        stderr: "",
      };
    }
    if (args[0] === "image" && args[3] === "{{.Os}}/{{.Architecture}}") {
      return { stdout: "linux/amd64\n", stderr: "" };
    }
    if (args[0] === "rm" && args.includes("openapp-image-smoke-smoke-cleanup-failure")) {
      cleanupAttempts += 1;
      throw new Error("daemon temporarily unavailable");
    }
    return { stdout: "", stderr: "" };
  }, () => "smoke-cleanup-failure");

  await assert.rejects(
    runtime.validateBuiltImage("sample-app-runtime:built", SAMPLE_APP_RUNTIME_CONTRACT_FIXTURE),
    /runtime_image_smoke_cleanup_failed/u,
  );
  assert.equal(cleanupAttempts, 3);
});

test("image cleanup removes only the guarded immutable image", async () => {
  const expected = `sha256:${"a".repeat(64)}`;
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") return { stdout: `${expected}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  });
  assert.equal(await runtime.removeImageIfCurrent("sample-app-runtime:failed", expected), true);
  assert.deepEqual(calls, [
    ["image", "inspect", "--format", "{{.Id}}", "sample-app-runtime:failed"],
    ["image", "rm", "sample-app-runtime:failed"],
  ]);

  calls.length = 0;
  const moved = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "image" && args[1] === "inspect") return { stdout: `sha256:${"b".repeat(64)}\n`, stderr: "" };
    return { stdout: "", stderr: "" };
  });
  assert.equal(await moved.removeImageIfCurrent("sample-app-runtime:failed", expected), false);
  assert.deepEqual(calls, [["image", "inspect", "--format", "{{.Id}}", "sample-app-runtime:failed"]]);
});

test("runtime commands use short probe deadlines and long image-operation deadlines", async () => {
  const calls: Array<{ command: string; timeoutMs: number | undefined }> = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args, options) => {
    calls.push({ command: String(args[0]), timeoutMs: options?.timeoutMs });
    if (args[0] === "stats") {
      return { stdout: JSON.stringify({ CPUPerc: "1%", MemUsage: "1MiB / 1GiB", NetIO: "1KiB / 1KiB", PIDs: "1" }), stderr: "" };
    }
    if (args[0] === "version") return { stdout: "1.0.0|linux|arm64", stderr: "" };
    if (args[0] === "load") return { stdout: "Loaded image: sample-app-runtime:test\n", stderr: "" };
    return { stdout: "", stderr: "" };
  });

  await runtime.status();
  await runtime.sampleActivity("inst_timeout");
  await runtime.pullImage("sample-app-runtime:test");
  await runtime.loadImage("/tmp/image.tar", "sample-app-runtime:test");

  assert.deepEqual(calls.map((call) => call.command), ["version", "stats", "pull", "load"]);
  assert.equal(calls[0]?.timeoutMs, 10_000);
  assert.equal(calls[1]?.timeoutMs, 10_000);
  assert.equal(calls[2]?.timeoutMs, 30 * 60_000);
  assert.equal(calls[3]?.timeoutMs, 30 * 60_000);
});

test("activity sampling returns normalized Docker network and compute metrics", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    return {
      stdout: JSON.stringify({
        CPUPerc: "2.75%",
        MemUsage: "128.5MiB / 1GiB",
        NetIO: "1.5MiB / 640kB",
        PIDs: "14",
      }),
      stderr: "",
    };
  });

  assert.deepEqual(await runtime.sampleActivity("inst_metrics"), {
    networkRxBytes: 1_572_864,
    networkTxBytes: 640_000,
    cpuPercent: 2.75,
    memoryWorkingSetBytes: 134_742_016,
    pids: 14,
  });
  assert.deepEqual(calls, [["stats", "--no-stream", "--format", "{{json .}}", "test-user-inst_metrics"]]);
});

test("activity sampling rejects incomplete Docker metrics", async () => {
  const runtime = new DockerCliRuntime(config, async () => ({
    stdout: JSON.stringify({ CPUPerc: "0.5%", MemUsage: "32MiB / 1GiB", NetIO: "1KiB / 2KiB" }),
    stderr: "",
  }));

  await assert.rejects(runtime.sampleActivity("inst_metrics"), /unexpected docker stats PIDs/u);
});

test("diagnose reads managed container exit metadata, resource limits, and a bounded log tail", async () => {
  const instanceId = "inst_diagnostics";
  const ownerId = "user_diagnostics";
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      return {
        stdout: JSON.stringify([{
          Id: "1290c0ae578d0000000000000000000000000000000000000000000000000000",
          Created: "2026-07-15T00:00:00.000Z",
          Config: { Labels: {
            "io.sample-app.portal.managed": "true",
            "io.sample-app.portal.instance-id": instanceId,
            "io.sample-app.portal.owner-id": ownerId,
          } },
          State: { Status: "exited", ExitCode: 137, OOMKilled: true, Health: { Status: "unhealthy" } },
          HostConfig: { Memory: 2_147_483_648, MemorySwap: 4_294_967_296, NanoCpus: 1_000_000_000, PidsLimit: 256 },
          NetworkSettings: { Ports: {} },
        }]),
        stderr: "",
      };
    }
    if (args[0] === "logs") return { stdout: "last log line\n", stderr: "" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  assert.deepEqual(await runtime.diagnose(instanceId), {
    containerRole: "canonical",
    exitCode: 137,
    oomKilled: true,
    health: "unhealthy",
    memoryLimit: "2147483648",
    memorySwapLimit: "4294967296",
    cpus: "1",
    pidsLimit: 256,
    logTail: "last log line",
  });
  assert.deepEqual(calls, [
    ["container", "inspect", "test-user-inst_diagnostics"],
    ["container", "inspect", "test-user-inst_diagnostics-rebuild-rollback"],
    ["container", "inspect", "test-user-inst_diagnostics-rebuild-next"],
    ["container", "inspect", "test-user-inst_diagnostics-rebuild-previous"],
    ["logs", "--tail", "100", "test-user-inst_diagnostics"],
  ]);
});

test("diagnose prefers a failed previous generation over an unstarted rollback artifact", async () => {
  const instanceId = "inst_diagnostics_artifacts";
  const ownerId = "user_diagnostics_artifacts";
  const previousName = `test-user-${instanceId}-rebuild-previous`;
  const rollbackName = `test-user-${instanceId}-rebuild-rollback`;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    if (isContainerInspect(args)) {
      const name = String(args[2]);
      if (name !== previousName && name !== rollbackName) throw new Error("No such container");
      const previous = name === previousName;
      return {
        stdout: JSON.stringify([{
          Id: previous
            ? "2290c0ae578d0000000000000000000000000000000000000000000000000000"
            : "3290c0ae578d0000000000000000000000000000000000000000000000000000",
          Created: "2026-07-15T00:00:00.000Z",
          Config: { Labels: {
            "io.sample-app.portal.managed": "true",
            "io.sample-app.portal.instance-id": instanceId,
            "io.sample-app.portal.owner-id": ownerId,
          } },
          State: previous
            ? { Status: "exited", ExitCode: 137, OOMKilled: true }
            : { Status: "created", ExitCode: 0, OOMKilled: false },
          HostConfig: {},
          NetworkSettings: { Ports: {} },
        }]),
        stderr: "",
      };
    }
    if (args[0] === "logs") {
      assert.equal(args[3], previousName);
      return { stdout: "previous failed with OOM\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  });

  const diagnostics = await runtime.diagnose(instanceId);
  assert.equal(diagnostics.containerRole, "previous");
  assert.equal(diagnostics.exitCode, 137);
  assert.equal(diagnostics.oomKilled, true);
  assert.equal(diagnostics.logTail, "previous failed with OOM");
});

test("provision applies fixed image, storage and resource policy", async () => {
  const calls: string[][] = [];
  let exists = false;
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "network" || args[0] === "volume") {
      if (args[1] === "inspect") throw new Error(`No such ${args[0]}`);
      return { stdout: String(args.at(-1)), stderr: "" };
    }
    if (args[0] === "inspect") throw new Error("generic inspect is forbidden by the Docker Socket Proxy");
    if (isContainerInspect(args) && !exists) throw new Error("No such container");
    if (args[0] === "create") exists = true;
    return { stdout: isContainerInspect(args) ? inspect("inst_1", "user_7") : "", stderr: "" };
  };

  const runtime = new DockerCliRuntime(config, run);
  const instance = await runtime.provision({ instanceId: "inst_1", ownerId: "user_7" });
  assert.equal(instance.endpoint, "http://127.0.0.1:49152");

  const runArgs = calls.find((args) => args[0] === "create");
  assert.ok(runArgs);
  assert.deepEqual(runArgs.slice(-1), ["sample-app-runtime:test"]);
  assert.ok(runArgs.includes("type=volume,source=test-data-inst_1,target=/var/lib/sample-app"));
  assert.ok(runArgs.includes("no-new-privileges=true"));
  assert.ok(runArgs.includes("127.0.0.1::37371"));
  const environmentIndexes = runArgs.flatMap((arg, index) => arg === "--env" ? [index] : []);
  assert.ok(
    environmentIndexes.every((index) => runArgs[index + 1]?.includes("=")),
    "Docker create must not contain an orphaned --env argument",
  );
  assert.equal(runArgs.some((arg) => arg.startsWith("SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINERS=")), false);
  assert.ok(runArgs.includes("SAMPLE_APP_MCP_APP_SANDBOX_ORIGIN=https://openapp-mcp.example.test"));
  assert.equal(runArgs.includes("user_7"), false, "owner id must not become a command or image argument");
  assert.equal(calls.filter((args) => args[0] === "network" && args[1] === "create").length, 2);
  const networkCreates = calls.filter((args) => args[0] === "network" && args[1] === "create");
  assert.ok(networkCreates.every((args) => args.includes("--subnet")));
  assert.ok(networkCreates.every((args) => args.includes("io.sample-app.portal.network-pool=10.240.0.0/12")));
  assert.ok(networkCreates.every((args) => args.some((arg) => /^io\.sample-app\.portal\.network-subnet=10\.(?:24[0-9]|25[0-5])\.\d+\.\d+\/28$/u.test(arg))));
  assert.notEqual(
    networkCreates[0]?.[networkCreates[0].indexOf("--subnet") + 1],
    networkCreates[1]?.[networkCreates[1].indexOf("--subnet") + 1],
  );
  assert.ok(calls.some((args) => args.join(" ") === "container inspect test-user-inst_1"));
  assert.equal(calls.some((args) => args[0] === "inspect"), false);
});

test("provision exposes an observable cleanup failure without leaking runner details", async () => {
  const calls: string[][] = [];
  const primarySecret = "DATABASE_URL=postgres://portal:primary-secret@db/openapp";
  const cleanupSecret = "-----BEGIN PRIVATE KEY----- cleanup-secret-body";
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      throw new Error(`No such ${args[0]}`);
    }
    if (isContainerInspect(args)) throw new Error("No such container");
    if (args[0] === "create") return { stdout: `${"a".repeat(64)}\n`, stderr: "" };
    if (args[0] === "network" && args[1] === "connect") {
      throw new Error(`candidate setup failed: ${primarySecret}`);
    }
    if (args[0] === "rm" && args[1] === "--force") {
      throw new Error(`candidate cleanup failed: ${cleanupSecret}`);
    }
    return { stdout: "", stderr: "" };
  });

  const failure = await runtime.provision({
    instanceId: "inst_cleanup_failure",
    ownerId: "user_cleanup_failure",
  }).then(
    () => undefined,
    (error: unknown) => error,
  );

  assert.ok(failure instanceof Error);
  assert.equal(failure.name, "DockerContainerCleanupError");
  assert.equal(failure.message, "runtime_provision_container_cleanup_failed");
  assert.equal(
    (failure as Error & { code?: unknown }).code,
    "runtime_provision_container_cleanup_failed",
  );
  assert.equal(calls.some((args) => args.join(" ") === "rm --force test-user-inst_cleanup_failure"), true);
  assert.equal(failure.message.includes(primarySecret), false);
  assert.equal(failure.message.includes(cleanupSecret), false);
});

test("provision probes the next managed subnet after an overlap", async () => {
  const calls: string[][] = [];
  let exists = false;
  let overlapInjected = false;
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      throw new Error(`No such ${args[0]}`);
    }
    if (args[0] === "network" && args[1] === "create" && !overlapInjected) {
      overlapInjected = true;
      throw new Error("Pool overlaps with other one on this address space");
    }
    if (isContainerInspect(args) && !exists) throw new Error("No such container");
    if (args[0] === "create") exists = true;
    return { stdout: isContainerInspect(args) ? inspect("inst_overlap", "user_overlap") : "", stderr: "" };
  };

  const runtime = new DockerCliRuntime(config, run);
  await runtime.provision({ instanceId: "inst_overlap", ownerId: "user_overlap" });

  const networkCreates = calls.filter((args) => args[0] === "network" && args[1] === "create");
  assert.equal(networkCreates.length, 3);
  assert.notEqual(
    networkCreates[0]?.[networkCreates[0].indexOf("--subnet") + 1],
    networkCreates[1]?.[networkCreates[1].indexOf("--subnet") + 1],
  );
});

test("provision reports a bounded error when its managed address pool is exhausted", async () => {
  let networkCreates = 0;
  const runtime = new DockerCliRuntime({
    ...config,
    networkPoolCidr: "192.168.20.0/28",
    networkSubnetPrefix: 29,
  }, async (_binary, args) => {
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      throw new Error(`No such ${args[0]}`);
    }
    if (args[0] === "network" && args[1] === "create") {
      networkCreates += 1;
      throw new Error("Pool overlaps with other one on this address space");
    }
    if (isContainerInspect(args)) throw new Error("No such container");
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(
    runtime.provision({ instanceId: "inst_exhausted", ownerId: "user_exhausted" }),
    /managed network address pool exhausted after 2 probes/u,
  );
  assert.equal(networkCreates, 2);
});

test("provision searches beyond 1024 overlapping subnet candidates", async () => {
  let exists = false;
  let networkCreates = 0;
  const runtime = new DockerCliRuntime({
    ...config,
    networkPoolCidr: "10.240.0.0/18",
    networkSubnetPrefix: 29,
  }, async (_binary, args) => {
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      throw new Error(`No such ${args[0]}`);
    }
    if (args[0] === "network" && args[1] === "create") {
      networkCreates += 1;
      if (networkCreates <= 1_024) {
        throw new Error("Pool overlaps with other one on this address space");
      }
    }
    if (isContainerInspect(args) && !exists) throw new Error("No such container");
    if (args[0] === "create") exists = true;
    return { stdout: isContainerInspect(args) ? inspect("inst_fragmented", "user_fragmented") : "", stderr: "" };
  });

  await runtime.provision({ instanceId: "inst_fragmented", ownerId: "user_fragmented" });
  assert.equal(networkCreates, 1_026);
});

test("provision applies the validated launch profile", async () => {
  const calls: string[][] = [];
  let exists = false;
  let containerLabels: Record<string, string> = {};
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "network" || args[0] === "volume") {
      if (args[1] === "inspect") throw new Error(`No such ${args[0]}`);
      return { stdout: String(args.at(-1)), stderr: "" };
    }
    if (isContainerInspect(args) && !exists) throw new Error("No such container");
    if (args[0] === "create") {
      exists = true;
      containerLabels = labelValues(args);
    }
    return {
      stdout: isContainerInspect(args)
        ? inspect("inst_profile", "user_profile", "running", { labels: containerLabels })
        : "",
      stderr: "",
    };
  };
  const runtime = new DockerCliRuntime(config, run);
  const provisioned = await runtime.provision({
    instanceId: "inst_profile",
    ownerId: "user_profile",
    appId: "story-app",
    appVersionId: "version-1",
    imageArtifactId: "artifact-1",
    imageReference: "registry.example.test/sample-app:v2",
    launchProfile: {
      imageReference: "registry.example.test/sample-app:v2",
      resources: { memory: "6g", cpus: "3.5", pidsLimit: 640 },
      environment: { FEATURE_FLAG: "enabled", ZONE: "cn-east", DATA_DIR: "/data", CUSTOM_STATE_PATH: "/data/state", OTHER_BRIDGE_SETTINGS_PATH: "/data/config" },
      configFiles: [{ path: ".claude/settings.json", content: "{\"model\":\"sonnet\"}" }],
    },
  });
  const args = calls.find((entry) => entry[0] === "create");
  assert.ok(args);
  assert.equal(args.at(-1), "registry.example.test/sample-app:v2");
  assert.ok(args.includes("6g"));
  assert.ok(args.includes("3.5"));
  assert.ok(args.includes("640"));
  assert.ok(args.includes("DATA_DIR=/data"));
  assert.ok(args.includes("CUSTOM_STATE_PATH=/data/state"));
  assert.ok(args.includes("OTHER_BRIDGE_SETTINGS_PATH=/data/config"));
  assert.ok(args.includes("FEATURE_FLAG=enabled"));
  assert.ok(args.includes("ZONE=cn-east"));
  assert.ok(args.includes('SAMPLE_APP_CONFIG_FILES_JSON=[{"path":".claude/settings.json","content":"{\\"model\\":\\"sonnet\\"}"}]'));
  assert.ok(args.includes("io.sample-app.portal.app-id=story-app"));
  assert.ok(args.includes("io.sample-app.portal.app-version-id=version-1"));
  assert.ok(args.includes("io.sample-app.portal.image-artifact-id=artifact-1"));
  assert.ok(args.includes("io.sample-app.portal.image-reference=registry.example.test/sample-app:v2"));
  assert.ok(args.includes("io.sample-app.portal.catalog-snapshot=true"));
  assert.deepEqual(provisioned.catalogSnapshot, {
    appId: "story-app",
    appVersionId: "version-1",
    imageArtifactId: "artifact-1",
    imageReference: "registry.example.test/sample-app:v2",
  });
});

test("launch profile rejects unsafe config paths and reserved environment", async () => {
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "create") return { stdout: String(args.at(-1)), stderr: "" };
    if (args[0] === "network" || args[0] === "volume") throw new Error(`No such ${args[0]}`);
    throw new Error("No such container");
  });
  const base = {
    imageReference: "sample-app-runtime:v2",
    resources: { memory: "2g", cpus: "1", pidsLimit: 128 },
    environment: {},
    configFiles: [],
  };
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, configFiles: [{ path: "../escape", content: "x" }] } }),
    /config path is unsafe/u,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, environment: { SAMPLE_APP_DATA_DIR: "/tmp" } } }),
    /environment key is not allowed/u,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, environment: { SAMPLE_APP_AUTH_BASE_URL: "https://attacker.invalid" } } }),
    /environment key is not allowed/u,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, environment: { SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINERS: "arbitrary" } } }),
    /environment key is not allowed/u,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, environment: { LARGE_VALUE: "x".repeat(64 * 1024) } } }),
    /environment is too large/u,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, configFiles: [{ path: "data/large.txt", content: "x".repeat(256 * 1024) }] } }),
    /config files are too large/u,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, resources: { ...base.resources, memory: "0g" } } }),
    /launch profile memory is invalid/u,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_bad", ownerId: "user_bad", launchProfile: { ...base, resources: { ...base.resources, memory: "999999999g" } } }),
    /launch profile memory is invalid/u,
  );
});

test("rebuild transaction inspection proves a stopped deferred candidate is pending", async () => {
  const instanceId = "inst_transaction_pending";
  const transactionId = "transaction-pending";
  const canonicalName = `test-user-${instanceId}`;
  const predecessorId = "1".repeat(64);
  const candidateId = "2".repeat(64);
  const calls: string[][] = [];
  const runtime = runtimeWithRebuildArtifacts({
    [canonicalName]: inspect(instanceId, "user_transaction", "created", {
      id: candidateId,
      labels: rebuildLabels(transactionId, predecessorId, false),
    }),
    [`${canonicalName}-rebuild-previous`]: inspect(instanceId, "user_transaction", "exited", {
      id: predecessorId,
    }),
  }, calls);

  const proof = await runtime.inspectRebuildTransaction!(instanceId, transactionId);

  assert.equal(proof.status, "pending");
  assert.equal(proof.instance?.runtimeId, candidateId);
  assert.equal(calls.length, 4);
  assert.equal(calls.every(isContainerInspect), true);
});

test("rebuild transaction inspection keeps a healthy committed candidate committed after stop", async () => {
  const instanceId = "inst_transaction_committed";
  const transactionId = "transaction-committed";
  const canonicalName = `test-user-${instanceId}`;
  const predecessorId = "3".repeat(64);
  const candidateId = "4".repeat(64);
  const runtime = runtimeWithRebuildArtifacts({
    [canonicalName]: inspect(instanceId, "user_transaction", "exited", {
      id: candidateId,
      labels: rebuildLabels(transactionId, predecessorId, false),
    }),
  });

  const proof = await runtime.inspectRebuildTransaction!(instanceId, transactionId);

  assert.equal(proof.status, "committed");
  assert.equal(proof.instance?.runtimeId, candidateId);
  assert.equal(proof.instance?.state, "stopped");
});

test("rebuild transaction inspection reports not_found after rollback artifacts are gone", async () => {
  const instanceId = "inst_transaction_rolled_back";
  const transactionId = "transaction-rolled-back";
  const canonicalName = `test-user-${instanceId}`;
  const predecessorId = "5".repeat(64);
  const runtime = runtimeWithRebuildArtifacts({
    [canonicalName]: inspect(instanceId, "user_transaction", "running", { id: predecessorId }),
  });

  const proof = await runtime.inspectRebuildTransaction!(instanceId, transactionId);

  assert.equal(proof.status, "not_found");
  assert.equal(proof.instance?.runtimeId, predecessorId);
});

test("rebuild transaction inspection rejects a conflicting predecessor relationship", async () => {
  const instanceId = "inst_transaction_conflict";
  const transactionId = "transaction-conflict";
  const canonicalName = `test-user-${instanceId}`;
  const predecessorId = "6".repeat(64);
  const unrelatedId = "7".repeat(64);
  const candidateId = "8".repeat(64);
  const runtime = runtimeWithRebuildArtifacts({
    [canonicalName]: inspect(instanceId, "user_transaction", "created", {
      id: candidateId,
      labels: rebuildLabels(transactionId, unrelatedId, false),
    }),
    [`${canonicalName}-rebuild-previous`]: inspect(instanceId, "user_transaction", "exited", {
      id: predecessorId,
    }),
  });

  const proof = await runtime.inspectRebuildTransaction!(instanceId, transactionId);

  assert.equal(proof.status, "inconsistent");
  assert.equal(proof.instance?.runtimeId, candidateId);
});

test("rebuild applies the requested profile without starting a stopped instance", async () => {
  const calls: string[][] = [];
  const attachmentRef = "provider-data-bound-rebuild";
  let exists = true;
  let state = "stopped";
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), "inst_rebuild", "user_rebuild"), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), "inst_rebuild", "user_rebuild"), stderr: "" };
    }
    if (isContainerInspect(args)) {
      if (args[2] !== "test-user-inst_rebuild") throw new Error("No such container");
      if (!exists) throw new Error("No such container");
      return {
        stdout: inspect("inst_rebuild", "user_rebuild", state, { hostname: "fda523b623bd" }),
        stderr: "",
      };
    }
    if (args[0] === "rm") exists = false;
    if (args[0] === "create") { exists = true; state = "created"; }
    if (args[0] === "start") state = "running";
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  const rebuilt = await runtime.rebuild({
    instanceId: "inst_rebuild",
    ownerId: "user_rebuild",
    start: false,
    storageBindings: [storageBinding("inst_rebuild", attachmentRef)],
    launchProfile: {
      imageReference: "registry.example.test/sample-app:v3",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  });

  assert.equal(rebuilt.state, "stopped");
  assert.ok(calls.some((args) => args.join(" ") === "rename test-user-inst_rebuild test-user-inst_rebuild-rebuild-previous"));
  assert.ok(calls.some((args) => args.join(" ") === "rename test-user-inst_rebuild-rebuild-next test-user-inst_rebuild"));
  assert.equal(calls.some((args) => args.join(" ") === "rm --force test-user-inst_rebuild-rebuild-previous"), false);
  assert.equal(calls.some((args) => args[0] === "start"), false);
  const create = calls.find((args) => args[0] === "create");
  assert.ok(create);
  assert.equal(create.at(-1), "registry.example.test/sample-app:v3");
  assert.ok(create.includes("8g"));
  assert.ok(create.includes("4"));
  assert.ok(create.includes("1024"));
  assert.ok(create.includes(`type=volume,source=${attachmentRef},target=/var/lib/sample-app`));
  assert.equal(calls.some((args) => args.includes("test-data-inst_rebuild")), false);
  assert.ok(create.includes("SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINERS=1290c0ae578d0000000000000000000000000000000000000000000000000000"));
  assert.ok(create.includes("SAMPLE_APP_STATE_LOCK_RECOVER_HOSTS=fda523b623bd"));
});

test("a stopped rebuild retains its predecessor until the first healthy start", async () => {
  const calls: string[][] = [];
  const instanceId = "inst_staged_start";
  const ownerId = "user_staged_start";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const previousId = "a".repeat(64);
  const candidateId = "b".repeat(64);
  const sourceCatalogSnapshot = {
    appId: "story-app",
    appVersionId: "version-old",
    imageArtifactId: "artifact-old",
    imageReference: "registry.example.test/sample-app:v3",
  };
  const targetCatalogSnapshot = {
    appId: "story-app",
    appVersionId: "version-new",
    imageArtifactId: "artifact-new",
    imageReference: "registry.example.test/sample-app:v4",
  };
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: previousId,
      state: "stopped",
      labels: {
        "io.sample-app.portal.catalog-snapshot": "true",
        "io.sample-app.portal.app-id": sourceCatalogSnapshot.appId,
        "io.sample-app.portal.app-version-id": sourceCatalogSnapshot.appVersionId,
        "io.sample-app.portal.image-artifact-id": sourceCatalogSnapshot.imageArtifactId,
        "io.sample-app.portal.image-reference": sourceCatalogSnapshot.imageReference,
      },
    }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, container.state, {
          id: container.id,
          hostname: container.id.slice(0, 12),
          labels: container.labels,
        }),
        stderr: "",
      };
    }
    if (args[0] === "create") {
      containers.set(candidateName, { id: candidateId, state: "created", labels: labelValues(args) });
    }
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const container = containers.get(source);
      if (!container) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, container);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      if (!containers.has(name)) throw new Error(`No such container: ${name}`);
      containers.delete(name);
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run, () => "staged-start-transaction");

  const staged = await runtime.rebuild({
    instanceId,
    ownerId,
    appId: targetCatalogSnapshot.appId,
    appVersionId: targetCatalogSnapshot.appVersionId,
    imageArtifactId: targetCatalogSnapshot.imageArtifactId,
    imageReference: targetCatalogSnapshot.imageReference,
    sourceCatalogSnapshot,
    start: false,
    launchProfile: {
      imageReference: targetCatalogSnapshot.imageReference,
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  });
  assert.equal(staged.state, "stopped");
  assert.deepEqual(staged.catalogSnapshot, targetCatalogSnapshot);
  assert.equal(containers.get(canonicalName)?.id, candidateId);
  assert.equal(containers.get(previousName)?.id, previousId);
  const candidateLabels = containers.get(canonicalName)?.labels;
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-id"], "staged-start-transaction");
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-predecessor-id"], previousId);
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-role"], "candidate");
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-start-requested"], "false");
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-source-catalog-snapshot"], "true");
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-source-app-version-id"], sourceCatalogSnapshot.appVersionId);
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-source-image-artifact-id"], sourceCatalogSnapshot.imageArtifactId);
  assert.equal(candidateLabels?.["io.sample-app.portal.rebuild-source-image-reference"], sourceCatalogSnapshot.imageReference);

  const started = await runtime.start(instanceId);
  assert.equal(started.state, "running");
  assert.deepEqual(started.catalogSnapshot, targetCatalogSnapshot);
  assert.equal(containers.get(canonicalName)?.id, candidateId);
  assert.equal(containers.has(previousName), false);
  const startIndex = calls.findIndex((args) => args.join(" ") === `start ${canonicalName}`);
  const probeIndex = calls.findIndex((args) => isHealthProbe(args) && args.includes(`container:${canonicalName}`));
  const commitIndex = calls.findIndex((args) => args.join(" ") === `rm --force ${previousName}`);
  assert.ok(startIndex >= 0 && probeIndex > startIndex && commitIndex > probeIndex);
});

test("a newer rebuild can accept the latest deferred candidate as its only rollback baseline", async () => {
  const instanceId = "inst_deferred_baseline";
  const ownerId = "user_deferred_baseline";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const v1Id = "1".repeat(64);
  const v2Id = "2".repeat(64);
  const v3Id = "3".repeat(64);
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: v2Id,
      state: "created",
      labels: {
        ...rebuildLabels("deploy-v2", v1Id, false),
        "io.sample-app.portal.catalog-snapshot": "true",
        "io.sample-app.portal.app-id": "sample-app",
        "io.sample-app.portal.app-version-id": "version-v2",
        "io.sample-app.portal.image-artifact-id": "artifact-v2",
        "io.sample-app.portal.image-reference": "registry.example.test/sample-app:v2",
      },
    }],
    [previousName, { id: v1Id, state: "exited", labels: {} }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, container.state, {
          id: container.id,
          hostname: container.id.slice(0, 12),
          labels: container.labels,
        }),
        stderr: "",
      };
    }
    if (args[0] === "create") {
      containers.set(candidateName, { id: v3Id, state: "created", labels: labelValues(args) });
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (isHealthProbe(args)) throw new Error("v3_first_start_unhealthy");
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "exited";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const container = containers.get(source);
      if (!container) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, container);
    }
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      if (!containers.has(name)) throw new Error(`No such container: ${name}`);
      containers.delete(name);
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run, () => "deploy-v3");

  assert.equal(await runtime.acceptDeferredCandidate!(instanceId, ownerId), "accepted");
  assert.equal(await runtime.acceptDeferredCandidate!(instanceId, ownerId), "already_baseline");

  const rebuilt = await runtime.rebuild({
    instanceId,
    ownerId,
    appId: "sample-app",
    appVersionId: "version-v3",
    imageArtifactId: "artifact-v3",
    imageReference: "registry.example.test/sample-app:v3",
    sourceCatalogSnapshot: {
      appId: "sample-app",
      appVersionId: "version-v2",
      imageArtifactId: "artifact-v2",
      imageReference: "registry.example.test/sample-app:v2",
    },
    start: false,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:v3",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  });

  assert.equal(rebuilt.runtimeId, v3Id);
  assert.equal(containers.get(canonicalName)?.id, v3Id);
  assert.equal(containers.get(previousName)?.id, v2Id);
  assert.equal([...containers.values()].some((container) => container.id === v1Id), false);
  assert.equal(containers.get(canonicalName)?.labels["io.sample-app.portal.rebuild-predecessor-id"], v2Id);
  const acceptIndex = calls.findIndex((args) => args.join(" ") === `rm --force ${previousName}`);
  const stageIndex = calls.findIndex((args) => args[0] === "create");
  assert.ok(acceptIndex >= 0 && stageIndex > acceptIndex);

  await assert.rejects(runtime.start(instanceId), /v3_first_start_unhealthy/u);
  assert.equal(containers.get(canonicalName)?.id, v2Id);
  assert.equal(containers.has(previousName), false);
  assert.equal([...containers.values()].some((container) => container.id === v1Id), false);
  assert.equal([...containers.values()].some((container) => container.id === v3Id), false);
});

test("a stopped rebuild first start keeps the healthy candidate when the predecessor removal response is lost", async () => {
  const instanceId = "inst_staged_start_commit_response_lost";
  const ownerId = "user_staged_start_commit_response_lost";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  const previousId = "7".repeat(64);
  const candidateId = "8".repeat(64);
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: candidateId,
      state: "created",
      labels: rebuildLabels("staged-start-response-lost-transaction", previousId, false),
    }],
    [previousName, { id: previousId, state: "created", labels: {} }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      if (!containers.has(name)) throw new Error(`No such container: ${name}`);
      containers.delete(name);
      if (name === previousName) throw new Error("previous_remove_response_lost");
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  const started = await runtime.start(instanceId);

  assert.equal(started.runtimeId, candidateId);
  assert.equal(started.state, "running");
  assert.equal(containers.get(canonicalName)?.id, candidateId);
  assert.equal(containers.has(previousName), false);
  assert.equal(containers.has(rollbackName), false);
  assert.equal(calls.some((args) => args.join(" ") === `stop --time 30 ${canonicalName}`), false);
  assert.equal(calls.some((args) => args.join(" ") === `rename ${canonicalName} ${rollbackName}`), false);
});

test("an unhealthy first start restores the staged predecessor and exposes its catalog snapshot", async () => {
  const instanceId = "inst_staged_start_rollback";
  const ownerId = "user_staged_start_rollback";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const previousId = "c".repeat(64);
  const candidateId = "d".repeat(64);
  const sourceCatalogSnapshot = {
    appId: "story-app",
    appVersionId: "version-old",
    imageArtifactId: "artifact-old",
    imageReference: "registry.example.test/sample-app:v3",
  };
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: candidateId,
      state: "created",
      labels: {
        "io.sample-app.portal.catalog-snapshot": "true",
        "io.sample-app.portal.app-id": "story-app",
        "io.sample-app.portal.app-version-id": "version-new",
        "io.sample-app.portal.image-artifact-id": "artifact-new",
        "io.sample-app.portal.image-reference": "registry.example.test/sample-app:v4",
        "io.sample-app.portal.rebuild-id": "staged-start-rollback-transaction",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "false",
        "io.sample-app.portal.rebuild-source-catalog-snapshot": "true",
        "io.sample-app.portal.rebuild-source-app-id": sourceCatalogSnapshot.appId,
        "io.sample-app.portal.rebuild-source-app-version-id": sourceCatalogSnapshot.appVersionId,
        "io.sample-app.portal.rebuild-source-image-artifact-id": sourceCatalogSnapshot.imageArtifactId,
        "io.sample-app.portal.rebuild-source-image-reference": sourceCatalogSnapshot.imageReference,
      },
    }],
    [previousName, { id: previousId, state: "created", labels: {} }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, container.state, {
          id: container.id,
          hostname: container.id.slice(0, 12),
          labels: container.labels,
        }),
        stderr: "",
      };
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (isHealthProbe(args)) throw new Error("candidate_health_timeout");
    if (args[0] === "rm") containers.delete(String(args.at(-1)));
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const container = containers.get(source);
      if (!container) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, container);
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  await assert.rejects(runtime.start(instanceId), (error: unknown) => {
    assert.ok(error instanceof ContainerRebuildRollbackError);
    assert.match(error.message, /candidate_health_timeout/u);
    assert.equal(error.recoveredInstance.runtimeId, previousId);
    assert.equal(error.recoveredInstance.state, "running");
    assert.deepEqual(error.recoveredInstance.catalogSnapshot, sourceCatalogSnapshot);
    return true;
  });

  assert.equal(containers.get(canonicalName)?.id, previousId);
  assert.equal(containers.get(canonicalName)?.state, "running");
  assert.equal(containers.has(previousName), false);
  const recoveryIndex = calls.findIndex((args) => (
    args[0] === "run"
    && args.includes(`SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINERS=${candidateId}`)
    && args.at(-1) === "/opt/sample-app/recover-state-locks.mjs"
  ));
  assert.ok(
    calls[recoveryIndex]?.includes("registry.example.test/sample-app:v4"),
    "lock recovery must use the fenced candidate image instead of a possibly stale configured image",
  );
  assert.ok(calls[recoveryIndex]?.includes(`SAMPLE_APP_STATE_LOCK_RECOVER_HOSTS=${candidateId.slice(0, 12)}`));
  const previousStartIndex = calls.map((args) => args.join(" ")).lastIndexOf(`start ${canonicalName}`);
  assert.ok(recoveryIndex >= 0, "failed replacement locks must be fenced before rollback");
  assert.ok(previousStartIndex > recoveryIndex, "the predecessor can start only after reverse lock recovery");
});

test("rebuild restores the previous container when the replacement cannot start", async () => {
  const calls: string[][] = [];
  const canonicalName = "test-user-inst_rebuild_rollback";
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  let canonicalGeneration: "previous" | "replacement" = "previous";
  let replacementStartFailed = false;

  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return {
        stdout: managedResource("test-data-inst_rebuild_rollback", "inst_rebuild_rollback", "user_rebuild"),
        stderr: "",
      };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return {
        stdout: managedResource(String(args[2]), "inst_rebuild_rollback", "user_rebuild"),
        stderr: "",
      };
    }
    if (isContainerInspect(args)) {
      if (args[2] !== canonicalName) throw new Error("No such container");
      return {
        stdout: inspect("inst_rebuild_rollback", "user_rebuild", canonicalGeneration === "previous" ? "running" : "created"),
        stderr: "",
      };
    }
    if (args[0] === "rename" && args[1] === candidateName && args[2] === canonicalName) {
      canonicalGeneration = "replacement";
    }
    if (args[0] === "rename" && args[1] === previousName && args[2] === canonicalName) {
      canonicalGeneration = "previous";
    }
    if (args[0] === "start" && args[1] === canonicalName && canonicalGeneration === "replacement") {
      replacementStartFailed = true;
      throw new Error("replacement failed health startup");
    }
    return { stdout: "", stderr: "" };
  };

  const runtime = new DockerCliRuntime(config, run);
  await assert.rejects(runtime.rebuild({
    instanceId: "inst_rebuild_rollback",
    ownerId: "user_rebuild",
    launchProfile: {
      imageReference: "registry.example.test/sample-app:broken",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  }), /replacement failed health startup/u);

  assert.equal(replacementStartFailed, true);
  assert.equal(canonicalGeneration, "previous");
  const createIndex = calls.findIndex((args) => args[0] === "create");
  const predecessorStopIndex = calls.findIndex((args) => args.join(" ") === `stop --time 30 ${canonicalName}`);
  const candidateStartIndex = calls.findIndex((args) => args.join(" ") === `start ${canonicalName}`);
  const oldRemovalIndex = calls.findIndex((args) => args.join(" ") === `rm --force ${rollbackName}`);
  assert.ok(createIndex >= 0, "replacement must be created before touching the previous container");
  assert.ok(predecessorStopIndex > createIndex, "predecessor must stop after the candidate is staged");
  assert.ok(candidateStartIndex > predecessorStopIndex, "candidate must start only after the predecessor stops");
  assert.ok(oldRemovalIndex > createIndex, "failed replacement is removed only after it was staged");
  assert.ok(calls.some((args) => args.join(" ") === `rename ${previousName} ${canonicalName}`));
  assert.ok(calls.some((args) => args.join(" ") === `start ${canonicalName}`));
});

test("rebuild commits only after the replacement health probe succeeds", async () => {
  const calls: string[][] = [];
  const instanceId = "inst_rebuild_health";
  const ownerId = "user_rebuild_health";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const containers = new Map<string, { generation: "previous" | "replacement"; state: string }>([
    [canonicalName, { generation: "previous", state: "running" }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return { stdout: inspect(instanceId, ownerId, container.state), stderr: "" };
    }
    if (args[0] === "create") {
      containers.set(candidateName, { generation: "replacement", state: "created" });
    }
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const container = containers.get(source);
      if (!container) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, container);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (isHealthProbe(args)) throw new Error("replacement_health_timeout");
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      if (!containers.has(name)) throw new Error(`No such container: ${name}`);
      containers.delete(name);
    }
    return { stdout: "", stderr: "" };
  };

  const runtime = new DockerCliRuntime(config, run, () => "rebuild-health-transaction");
  await assert.rejects(runtime.rebuild({
    instanceId,
    ownerId,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:unhealthy",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  }), /replacement_health_timeout/u);

  assert.deepEqual(containers.get(canonicalName), { generation: "previous", state: "running" });
  assert.equal(containers.has(previousName), false);
  const probeIndex = calls.findIndex((args) => isHealthProbe(args) && args.includes(`container:${canonicalName}`));
  const predecessorRemovalIndex = calls.findIndex((args) => args.join(" ") === `rm --force ${previousName}`);
  assert.ok(probeIndex >= 0, "replacement must be probed through its public health endpoint");
  assert.equal(predecessorRemovalIndex, -1, "predecessor must remain available until health succeeds");
});

test("an aborted rebuild attempt stops issuing destructive Docker commands", async () => {
  const instanceId = "inst_rebuild_abort";
  const ownerId = "user_rebuild_abort";
  const canonicalName = `test-user-${instanceId}`;
  const controller = new AbortController();
  const calls: string[][] = [];
  let stopStarted!: () => void;
  const stopStartedPromise = new Promise<void>((resolve) => {
    stopStarted = resolve;
  });
  const run: CommandRunner = async (_binary, args, options) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      if (args[2] !== canonicalName) throw new Error("No such container");
      return { stdout: inspect(instanceId, ownerId, "running"), stderr: "" };
    }
    if (args[0] === "create") return { stdout: `${"b".repeat(64)}\n`, stderr: "" };
    if (args[0] === "stop") {
      stopStarted();
      await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      if (!options?.signal?.aborted) throw new Error("rebuild_signal_not_propagated");
      throw options.signal.reason;
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run, () => "runtime-generated-id-must-not-win");
  const rebuilding = runtime.rebuild({
    instanceId,
    ownerId,
    rebuildTransactionId: "attempt-runtime-fence",
    signal: controller.signal,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:fenced",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  });

  await stopStartedPromise;
  const stopIndex = calls.findIndex((args) => args[0] === "stop");
  const createLabels = labelValues(calls.find((args) => args[0] === "create") ?? []);
  assert.equal(createLabels["io.sample-app.portal.rebuild-id"], "attempt-runtime-fence");
  controller.abort(new Error("maintenance_lease_lost"));
  await assert.rejects(rebuilding, /maintenance_lease_lost/u);
  assert.equal(
    calls.slice(stopIndex + 1).some((args) => ["rename", "rm", "start", "run"].includes(String(args[0]))),
    false,
  );
});

test("a healthy running rebuild commits the predecessor exactly once", async () => {
  const instanceId = "inst_rebuild_commit_once";
  const ownerId = "user_rebuild_commit_once";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const previousId = "3".repeat(64);
  const candidateId = "4".repeat(64);
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([[
    canonicalName,
    { id: previousId, state: "running", labels: {} },
  ]]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "create") {
      containers.set(candidateName, { id: candidateId, state: "created", labels: labelValues(args) });
      return { stdout: `${candidateId}\n`, stderr: "" };
    }
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      if (!containers.has(name)) throw new Error(`No such container: ${name}`);
      containers.delete(name);
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run, () => "commit-once-transaction");

  const rebuilt = await runtime.rebuild({
    instanceId,
    ownerId,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:healthy",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  });

  assert.equal(rebuilt.runtimeId, candidateId);
  assert.equal(rebuilt.state, "running");
  assert.equal(containers.has(previousName), false);
  assert.equal(calls.filter((args) => args.join(" ") === `rm --force ${previousName}`).length, 1);
});

test("a running rebuild keeps the healthy candidate when the predecessor removal response is lost", async () => {
  const instanceId = "inst_rebuild_commit_response_lost";
  const ownerId = "user_rebuild_commit_response_lost";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  const previousId = "5".repeat(64);
  const candidateId = "6".repeat(64);
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([[
    canonicalName,
    { id: previousId, state: "running", labels: {} },
  ]]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "create") {
      containers.set(candidateName, { id: candidateId, state: "created", labels: labelValues(args) });
      return { stdout: `${candidateId}\n`, stderr: "" };
    }
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      if (!containers.has(name)) throw new Error(`No such container: ${name}`);
      containers.delete(name);
      if (name === previousName) throw new Error("previous_remove_response_lost");
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run, () => "commit-response-lost-transaction");

  const rebuilt = await runtime.rebuild({
    instanceId,
    ownerId,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:healthy",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  });

  assert.equal(rebuilt.runtimeId, candidateId);
  assert.equal(rebuilt.state, "running");
  assert.equal(containers.get(canonicalName)?.id, candidateId);
  assert.equal(containers.has(candidateName), false);
  assert.equal(containers.has(previousName), false);
  assert.equal(containers.has(rollbackName), false);
  assert.equal(calls.filter((args) => args.join(" ") === `stop --time 30 ${canonicalName}`).length, 1);
  assert.equal(calls.some((args) => args.join(" ") === `rename ${canonicalName} ${rollbackName}`), false);
});

test("a post-commit read failure never rolls back the healthy replacement", async () => {
  const instanceId = "inst_rebuild_post_commit_read";
  const ownerId = "user_rebuild_post_commit_read";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  const previousId = "a".repeat(64);
  const candidateId = "b".repeat(64);
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([[
    canonicalName,
    { id: previousId, state: "running", labels: {} },
  ]]);
  let failPostCommitRead = true;
  let committed = false;
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      if (committed && args[2] === canonicalName && failPostCommitRead) {
        failPostCommitRead = false;
        throw new Error("post_commit_inspect_failed");
      }
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "create") {
      containers.set(candidateName, { id: candidateId, state: "created", labels: labelValues(args) });
      return { stdout: `${candidateId}\n`, stderr: "" };
    }
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      containers.delete(name);
      if (name === previousName) committed = true;
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run, () => "post-commit-read-transaction");

  await assert.rejects(runtime.rebuild({
    instanceId,
    ownerId,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:committed",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  }), /post_commit_inspect_failed/u);

  assert.equal(containers.get(canonicalName)?.id, candidateId);
  assert.equal(containers.get(canonicalName)?.state, "running");
  assert.equal(containers.has(previousName), false);
  assert.equal(containers.has(rollbackName), false);
  assert.equal(calls.some((args) => args.join(" ") === `rm --force ${canonicalName}`), false);
  assert.equal((await runtime.get(instanceId))?.runtimeId, candidateId);
});

test("rebuild crash recovery rolls back an uncommitted canonical replacement", async () => {
  const calls: string[][] = [];
  const instanceId = "inst_rebuild_crash";
  const ownerId = "user_rebuild_crash";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  const previousId = "e".repeat(64);
  const replacementId = "f".repeat(64);
  const containers = new Map<string, { generation: "previous" | "replacement"; state: string; id: string; labels: Record<string, string> }>([
    [canonicalName, {
      generation: "replacement",
      state: "created",
      id: replacementId,
      labels: {
        "io.sample-app.portal.rebuild-id": "crash-recovery-transaction",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "true",
      },
    }],
    [previousName, { generation: "previous", state: "created", id: previousId, labels: {} }],
  ]);
  let volumeInspections = 0;
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return { stdout: inspect(instanceId, ownerId, container.state, { id: container.id, labels: container.labels }), stderr: "" };
    }
    if (args[0] === "rm") {
      containers.delete(String(args.at(-1)));
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const container = containers.get(source);
      if (!container) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, container);
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "start") {
      const container = containers.get(String(args[1]));
      if (!container) throw new Error("No such container");
      container.state = "running";
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      volumeInspections += 1;
      if (volumeInspections === 1) {
        return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
      }
      throw new Error("stop after crash recovery");
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  await assert.rejects(runtime.rebuild({
    instanceId,
    ownerId,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:v3",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  }), /stop after crash recovery/u);

  assert.deepEqual(containers.get(canonicalName), {
    generation: "previous",
    state: "running",
    id: previousId,
    labels: {},
  });
  assert.equal(containers.has(previousName), false);
  const replacementStaging = calls.findIndex((args) => args.join(" ") === `rename ${canonicalName} ${rollbackName}`);
  const previousRestore = calls.findIndex((args) => args.join(" ") === `rename ${previousName} ${canonicalName}`);
  const replacementRemoval = calls.findIndex((args) => args.join(" ") === `rm --force ${rollbackName}`);
  assert.ok(replacementStaging >= 0);
  assert.ok(previousRestore > replacementStaging);
  assert.ok(replacementRemoval > previousRestore);
});

test("get restores a labeled predecessor before exposing an unverified replacement", async () => {
  const instanceId = "inst_get_rebuild_crash";
  const ownerId = "user_get_rebuild_crash";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const previousId = "1".repeat(64);
  const replacementId = "2".repeat(64);
  const sourceCatalogSnapshot = {
    appId: "story-app",
    appVersionId: "version-before-crash",
    imageArtifactId: "artifact-before-crash",
    imageReference: "registry.example.test/sample-app:before-crash",
  };
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: replacementId,
      state: "created",
      labels: {
        "io.sample-app.portal.rebuild-id": "get-crash-transaction",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "true",
        "io.sample-app.portal.rebuild-source-catalog-snapshot": "true",
        "io.sample-app.portal.rebuild-source-app-id": sourceCatalogSnapshot.appId,
        "io.sample-app.portal.rebuild-source-app-version-id": sourceCatalogSnapshot.appVersionId,
        "io.sample-app.portal.rebuild-source-image-artifact-id": sourceCatalogSnapshot.imageArtifactId,
        "io.sample-app.portal.rebuild-source-image-reference": sourceCatalogSnapshot.imageReference,
      },
    }],
    [previousName, { id: previousId, state: "stopped", labels: {} }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, container.state, { id: container.id, labels: container.labels }),
        stderr: "",
      };
    }
    if (args[0] === "rm") containers.delete(String(args.at(-1)));
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const container = containers.get(source);
      if (!container) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, container);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  const recovered = await runtime.get(instanceId);

  assert.equal(recovered?.runtimeId, previousId);
  assert.equal(recovered?.state, "running");
  assert.deepEqual(recovered?.catalogSnapshot, sourceCatalogSnapshot);
  assert.equal(containers.has(previousName), false);
});

test("observe reads a committed canonical replacement without scanning or mutating side artifacts", async () => {
  const instanceId = "inst_observe_committed";
  const ownerId = "user_observe_committed";
  const canonicalName = `test-user-${instanceId}`;
  const calls: string[][] = [];
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args) && args[2] === canonicalName) {
      return {
        stdout: inspect(instanceId, ownerId, "running", {
          id: "a".repeat(64),
          labels: rebuildLabels("committed-observation", "b".repeat(64), true),
        }),
        stderr: "",
      };
    }
    throw new Error("observe attempted a side effect or side-artifact scan");
  };
  const runtime: ContainerRuntime = new DockerCliRuntime(config, run);

  const observed = await runtime.observe!(instanceId);

  assert.equal(observed?.state, "running");
  assert.equal(observed?.runtimeId, "a".repeat(64));
  assert.deepEqual(calls, [["container", "inspect", canonicalName]]);
});

test("get recognizes a committed canonical replacement without a full recovery scan", async () => {
  const instanceId = "inst_get_committed_fast";
  const ownerId = "user_get_committed_fast";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const calls: string[][] = [];
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args) && args[2] === canonicalName) {
      return {
        stdout: inspect(instanceId, ownerId, "running", {
          id: "c".repeat(64),
          labels: rebuildLabels("committed-fast-path", "d".repeat(64), true),
        }),
        stderr: "",
      };
    }
    if (isContainerInspect(args)) throw new Error("No such container");
    throw new Error("committed get attempted a mutating operation");
  };
  const runtime = new DockerCliRuntime(config, run);

  const current = await runtime.get(instanceId);

  assert.equal(current?.state, "running");
  assert.deepEqual(
    calls.filter(isContainerInspect).map((args) => args[2]),
    [canonicalName, previousName, `${canonicalName}-rebuild-next`, `${canonicalName}-rebuild-rollback`],
  );
});

test("get retries reverse lock fencing without losing candidate authorization metadata", async () => {
  const instanceId = "inst_get_lock_retry";
  const ownerId = "user_get_lock_retry";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  const previousId = "8".repeat(64);
  const candidateId = "9".repeat(64);
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: candidateId,
      state: "running",
      labels: {
        "io.sample-app.portal.rebuild-id": "lock-retry-transaction",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "true",
      },
    }],
    [previousName, { id: previousId, state: "stopped", labels: {} }],
  ]);
  let recoveryAttempts = 0;
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, container.state, { id: container.id, labels: container.labels }),
        stderr: "",
      };
    }
    if (isHealthProbe(args)) throw new Error("replacement_health_timeout");
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "run") {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) throw new Error("state_lock_helper_unavailable");
    }
    if (args[0] === "rm") containers.delete(String(args.at(-1)));
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const container = containers.get(source);
      if (!container) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, container);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  await assert.rejects(runtime.get(instanceId), /state_lock_helper_unavailable/u);
  assert.equal(containers.has(canonicalName), false);
  assert.equal(containers.get(rollbackName)?.id, candidateId);
  assert.equal(containers.get(rollbackName)?.state, "stopped");
  assert.equal(containers.get(previousName)?.id, previousId);
  assert.equal(calls.some((args) => args.join(" ") === `rm --force ${rollbackName}`), false);

  const recovered = await runtime.get(instanceId);
  assert.equal(recovered?.runtimeId, previousId);
  assert.equal(recovered?.state, "running");
  assert.equal(recoveryAttempts, 2);
  assert.equal(containers.has(previousName), false);
  const recoveryIndexes = calls
    .map((args, index) => args[0] === "run" && !isHealthProbe(args) ? index : -1)
    .filter((index) => index >= 0);
  const removalIndex = calls.findIndex((args) => args.join(" ") === `rm --force ${rollbackName}`);
  assert.equal(recoveryIndexes.length, 2);
  assert.ok(removalIndex > recoveryIndexes[1]!, "candidate is removed only after a successful retry");
});

test("get converges a deferred start after the first lock helper attempt fails", async () => {
  const instanceId = "inst_deferred_lock_retry";
  const ownerId = "user_deferred_lock_retry";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  const previousId = "c".repeat(64);
  const candidateId = "d".repeat(64);
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: candidateId,
      state: "created",
      labels: {
        "io.sample-app.portal.rebuild-id": "deferred-lock-retry",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "false",
      },
    }],
    [previousName, { id: previousId, state: "created", labels: {} }],
  ]);
  let recoveryAttempts = 0;
  let predecessorStarts = 0;
  const run: CommandRunner = async (_binary, args) => {
    if (isContainerInspect(args)) {
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "start") {
      const current = containers.get(String(args[1]));
      if (!current) throw new Error("No such container");
      current.state = "running";
      if (current.id === previousId) predecessorStarts += 1;
    }
    if (isHealthProbe(args)) throw new Error("deferred_candidate_unhealthy");
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "run") {
      recoveryAttempts += 1;
      if (recoveryAttempts === 1) throw new Error("state_lock_helper_unavailable");
    }
    if (args[0] === "rm") containers.delete(String(args.at(-1)));
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  await assert.rejects(runtime.start(instanceId), /rebuild rollback failed/u);
  assert.equal(containers.has(canonicalName), false);
  assert.equal(containers.get(rollbackName)?.id, candidateId);

  const recovered = await runtime.get(instanceId);
  assert.equal(recovered?.runtimeId, previousId);
  assert.equal(recovered?.state, "stopped");
  assert.equal(predecessorStarts, 0, "the original stopped intent must survive recovery");
  assert.equal(recoveryAttempts, 2);
  assert.equal(containers.has(rollbackName), false);
});

test("rollback tombstones recover every durable handoff state before deletion", async (t) => {
  const cases = [
    { name: "before predecessor rename", predecessorName: "previous", predecessorState: "stopped" },
    { name: "after predecessor rename", predecessorName: "canonical", predecessorState: "stopped" },
    { name: "after predecessor start", predecessorName: "canonical", predecessorState: "running" },
  ] as const;
  for (const [index, crash] of cases.entries()) {
    await t.test(crash.name, async () => {
      const instanceId = `inst_tombstone_${index}`;
      const ownerId = `user_tombstone_${index}`;
      const canonicalName = `test-user-${instanceId}`;
      const previousName = `${canonicalName}-rebuild-previous`;
      const rollbackName = `${canonicalName}-rebuild-rollback`;
      const previousId = String(index + 1).repeat(64);
      const candidateId = String(index + 6).repeat(64);
      const sourceCatalogSnapshot = {
        appId: "story-app",
        appVersionId: `version-tombstone-${index}`,
        imageArtifactId: `artifact-tombstone-${index}`,
        imageReference: `registry.example.test/sample-app:tombstone-${index}`,
      };
      const predecessorName = crash.predecessorName === "canonical" ? canonicalName : previousName;
      const calls: string[][] = [];
      const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
        [predecessorName, { id: previousId, state: crash.predecessorState, labels: {} }],
        [rollbackName, {
          id: candidateId,
          state: "stopped",
          labels: {
            "io.sample-app.portal.rebuild-id": `tombstone-transaction-${index}`,
            "io.sample-app.portal.rebuild-predecessor-id": previousId,
            "io.sample-app.portal.rebuild-role": "candidate",
            "io.sample-app.portal.rebuild-start-requested": "true",
            "io.sample-app.portal.rebuild-source-catalog-snapshot": "true",
            "io.sample-app.portal.rebuild-source-app-id": sourceCatalogSnapshot.appId,
            "io.sample-app.portal.rebuild-source-app-version-id": sourceCatalogSnapshot.appVersionId,
            "io.sample-app.portal.rebuild-source-image-artifact-id": sourceCatalogSnapshot.imageArtifactId,
            "io.sample-app.portal.rebuild-source-image-reference": sourceCatalogSnapshot.imageReference,
          },
        }],
      ]);
      const run: CommandRunner = async (_binary, args) => {
        calls.push([...args]);
        if (isContainerInspect(args)) {
          const current = containers.get(String(args[2]));
          if (!current) throw new Error("No such container");
          return {
            stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
            stderr: "",
          };
        }
        if (args[0] === "volume" && args[1] === "inspect") {
          return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
        }
        if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
        if (args[0] === "rename") {
          const source = String(args[1]);
          const target = String(args[2]);
          const current = containers.get(source);
          if (!current) throw new Error("No such container");
          containers.delete(source);
          containers.set(target, current);
        }
        if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
        if (args[0] === "rm") containers.delete(String(args.at(-1)));
        return { stdout: "", stderr: "" };
      };
      const runtime = new DockerCliRuntime(config, run);

      const recovered = await runtime.get(instanceId);
      assert.equal(recovered?.runtimeId, previousId);
      assert.equal(recovered?.state, "running");
      assert.equal(recovered?.rebuildRecovered, true);
      assert.deepEqual(recovered?.catalogSnapshot, sourceCatalogSnapshot);
      assert.equal(containers.has(rollbackName), false);
      const recoveryIndex = calls.findIndex((args) => args[0] === "run");
      const startIndex = calls.findIndex((args) => args.join(" ") === `start ${canonicalName}`);
      const removalIndex = calls.findIndex((args) => args.join(" ") === `rm --force ${rollbackName}`);
      assert.ok(recoveryIndex >= 0);
      if (crash.predecessorState === "stopped") assert.ok(startIndex > recoveryIndex);
      assert.ok(removalIndex > recoveryIndex);
      if (startIndex >= 0) assert.ok(removalIndex > startIndex);
    });
  }
});

test("get preserves running intent when a crash leaves previous and side candidate", async () => {
  const instanceId = "inst_get_previous_candidate_crash";
  const ownerId = "user_get_previous_candidate_crash";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const previousId = "5".repeat(64);
  const candidateId = "6".repeat(64);
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [candidateName, {
      id: candidateId,
      state: "created",
      labels: {
        "io.sample-app.portal.rebuild-id": "previous-candidate-crash",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "true",
      },
    }],
    [previousName, { id: previousId, state: "stopped", labels: {} }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    if (isContainerInspect(args)) {
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "rm") containers.delete(String(args.at(-1)));
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  const recovered = await runtime.get(instanceId);

  assert.equal(recovered?.runtimeId, previousId);
  assert.equal(recovered?.state, "running");
  assert.equal(containers.has(candidateName), false);
  assert.equal(containers.has(previousName), false);
});

test("get restores a stopped canonical when a crash happens before predecessor rename", async () => {
  const instanceId = "inst_get_stop_rename_crash";
  const ownerId = "user_get_stop_rename_crash";
  const canonicalName = `test-user-${instanceId}`;
  const candidateName = `${canonicalName}-rebuild-next`;
  const previousId = "7".repeat(64);
  const candidateId = "8".repeat(64);
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, { id: previousId, state: "stopped", labels: {} }],
    [candidateName, {
      id: candidateId,
      state: "created",
      labels: {
        "io.sample-app.portal.rebuild-id": "stop-rename-crash",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "true",
      },
    }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    if (isContainerInspect(args)) {
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "rm") containers.delete(String(args.at(-1)));
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "start") containers.get(String(args[1]))!.state = "running";
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  const recovered = await runtime.get(instanceId);

  assert.equal(recovered?.runtimeId, previousId);
  assert.equal(recovered?.state, "running");
  assert.equal(containers.has(candidateName), false);
});

test("rebuild recovery refuses an ambiguous canonical and predecessor pair", async () => {
  const instanceId = "inst_ambiguous_rebuild";
  const ownerId = "user_ambiguous_rebuild";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const containers = new Map<string, { id: string; state: string }>([
    [canonicalName, { id: "3".repeat(64), state: "running" }],
    [previousName, { id: "4".repeat(64), state: "stopped" }],
  ]);
  let mutated = false;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return { stdout: inspect(instanceId, ownerId, container.state, { id: container.id }), stderr: "" };
    }
    if (args[0] === "rm" || args[0] === "rename") mutated = true;
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(runtime.rebuild({
    instanceId,
    ownerId,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:v6",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  }), /rebuild predecessor metadata mismatch/u);

  assert.equal(mutated, false);
  assert.equal(containers.get(canonicalName)?.id, "3".repeat(64));
  assert.equal(containers.get(previousName)?.id, "4".repeat(64));
});

test("rebuild crash recovery commits a labeled replacement that is already healthy", async () => {
  const calls: string[][] = [];
  const instanceId = "inst_rebuild_committed_crash";
  const ownerId = "user_rebuild_committed_crash";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const previousId = "c".repeat(64);
  const replacementId = "d".repeat(64);
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: replacementId,
      state: "running",
      labels: {
        "io.sample-app.portal.rebuild-id": "rebuild-before-portal-crash",
        "io.sample-app.portal.rebuild-predecessor-id": previousId,
        "io.sample-app.portal.rebuild-role": "candidate",
        "io.sample-app.portal.rebuild-start-requested": "true",
      },
    }],
    [previousName, { id: previousId, state: "stopped", labels: {} }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      const container = containers.get(String(args[2]));
      if (!container) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, container.state, { id: container.id, labels: container.labels }),
        stderr: "",
      };
    }
    if (args[0] === "rm") {
      containers.delete(String(args.at(-1)));
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") throw new Error("stop after recovered commit");
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  await assert.rejects(runtime.rebuild({
    instanceId,
    ownerId,
    launchProfile: {
      imageReference: "registry.example.test/sample-app:v5",
      resources: { memory: "8g", cpus: "4", pidsLimit: 1024 },
      environment: {},
      configFiles: [],
    },
  }), /stop after recovered commit/u);

  assert.equal(containers.get(canonicalName)?.id, replacementId);
  assert.equal(containers.has(previousName), false);
  assert.ok(calls.some((args) => isHealthProbe(args) && args.includes(`container:${canonicalName}`)));
});

test("get keeps a healthy recovered candidate when the predecessor removal response is lost", async () => {
  const instanceId = "inst_get_commit_response_lost";
  const ownerId = "user_get_commit_response_lost";
  const canonicalName = `test-user-${instanceId}`;
  const previousName = `${canonicalName}-rebuild-previous`;
  const rollbackName = `${canonicalName}-rebuild-rollback`;
  const previousId = "d".repeat(64);
  const candidateId = "e".repeat(64);
  const calls: string[][] = [];
  const containers = new Map<string, { id: string; state: string; labels: Record<string, string> }>([
    [canonicalName, {
      id: candidateId,
      state: "running",
      labels: rebuildLabels("get-response-lost-transaction", previousId, true),
    }],
    [previousName, { id: previousId, state: "stopped", labels: {} }],
  ]);
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (isContainerInspect(args)) {
      const current = containers.get(String(args[2]));
      if (!current) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, current.state, { id: current.id, labels: current.labels }),
        stderr: "",
      };
    }
    if (args[0] === "stop") containers.get(String(args.at(-1)))!.state = "stopped";
    if (args[0] === "rename") {
      const source = String(args[1]);
      const target = String(args[2]);
      const current = containers.get(source);
      if (!current) throw new Error("No such container");
      containers.delete(source);
      containers.set(target, current);
    }
    if (args[0] === "rm") {
      const name = String(args.at(-1));
      if (!containers.has(name)) throw new Error(`No such container: ${name}`);
      containers.delete(name);
      if (name === previousName) throw new Error("previous_remove_response_lost");
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);

  const recovered = await runtime.get(instanceId);

  assert.equal(recovered?.runtimeId, candidateId);
  assert.equal(recovered?.state, "running");
  assert.equal(containers.get(canonicalName)?.id, candidateId);
  assert.equal(containers.has(previousName), false);
  assert.equal(containers.has(rollbackName), false);
  assert.equal(calls.some((args) => args.join(" ") === `stop --time 30 ${canonicalName}`), false);
  assert.equal(calls.some((args) => args.join(" ") === `rename ${canonicalName} ${rollbackName}`), false);
});

test("launch profile accepts a digest-pinned image reference", async () => {
  const calls: string[][] = [];
  let exists = false;
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "network" || args[0] === "volume") {
      if (args[1] === "inspect") throw new Error(`No such ${args[0]}`);
      return { stdout: String(args.at(-1)), stderr: "" };
    }
    if (isContainerInspect(args) && !exists) throw new Error("No such container");
    if (args[0] === "create") exists = true;
    return { stdout: isContainerInspect(args) ? inspect("inst_digest", "user_digest") : "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);
  const imageReference = `registry.example.test/sample-app@sha256:${"a".repeat(64)}`;
  await runtime.provision({
    instanceId: "inst_digest",
    ownerId: "user_digest",
    launchProfile: {
      imageReference,
      resources: { memory: "2g", cpus: "1", pidsLimit: 128 },
      environment: {},
      configFiles: [],
    },
  });
  assert.equal(calls.find((args) => args[0] === "create")?.at(-1), imageReference);
});

test("concurrent provisions create one isolated network per instance", async () => {
  const calls: string[][] = [];
  const networks = new Set<string>();
  const volumes = new Set<string>();
  let networkCreates = 0;
  const containers = new Set<string>();
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      const resources = args[0] === "network" ? networks : volumes;
      if (!resources.has(String(args[2]))) throw new Error(`No such ${args[0]}`);
      throw new Error("resource inspection should not repeat after successful creation");
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "create") {
      const resources = args[0] === "network" ? networks : volumes;
      resources.add(String(args.at(-1)));
      if (args[0] === "network") networkCreates += 1;
      return { stdout: String(args.at(-1)), stderr: "" };
    }
    const name = String(args.at(-1));
    if (isContainerInspect(args)) {
      const instanceId = name.replace("test-user-", "");
      if (!containers.has(instanceId)) throw new Error("No such container");
      return { stdout: inspect(instanceId, instanceId === "inst_a" ? "user_a" : "user_b"), stderr: "" };
    }
    if (args[0] === "create") {
      const instanceLabel = args.find((arg) => arg.startsWith("io.sample-app.portal.instance-id="));
      containers.add(String(instanceLabel).split("=")[1] ?? "");
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime(config, run);
  await Promise.all([
    runtime.provision({ instanceId: "inst_a", ownerId: "user_a" }),
    runtime.provision({ instanceId: "inst_b", ownerId: "user_b" }),
  ]);
  assert.equal(networkCreates, 4);
  assert.deepEqual([...networks].sort(), ["test-net-inst_a", "test-net-inst_a-egress", "test-net-inst_b", "test-net-inst_b-egress"]);
  const subnets = calls
    .filter((args) => args[0] === "network" && args[1] === "create")
    .map((args) => args[args.indexOf("--subnet") + 1]);
  assert.equal(new Set(subnets).size, 4);
});

test("network mode returns a private service endpoint without publishing a port", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) return { stdout: inspect("inst_2", "user_8"), stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") {
      const name = String(args[2]);
      return { stdout: managedResource(name, "inst_2", "user_8"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const runtime = new DockerCliRuntime({ ...config, endpointMode: "network", portalContainer: "portal-control-plane" }, run);
  const instance = await runtime.get("inst_2");
  assert.equal(instance?.endpoint, "http://test-user-inst_2:37371");
  assert.equal(calls.some((args) => args.includes("--publish")), false);
});

test("network mode provisions labeled per-instance resources and connects the Portal", async () => {
  const calls: string[][] = [];
  let containerExists = false;
  const networks = new Set<string>();
  const isolatedConfig = {
    ...config,
    endpointMode: "network" as const,
    networkPrefix: "test-net-",
    portalContainer: "portal-control-plane",
  } as DockerCliRuntimeConfig & { networkPrefix: string; portalContainer: string };
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      if (!containerExists) throw new Error("No such container");
      return { stdout: inspect("inst_isolated", "user_isolated"), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect" && networks.has(String(args[2]))) {
      return { stdout: managedResource(String(args[2]), "inst_isolated", "user_isolated"), stderr: "" };
    }
    if ((args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      throw new Error(`No such ${args[0]}`);
    }
    if (args[0] === "network" && args[1] === "create") networks.add(String(args.at(-1)));
    if (args[0] === "create") containerExists = true;
    return { stdout: "", stderr: "" };
  };

  const runtime = new DockerCliRuntime(isolatedConfig, run);
  await runtime.provision({ instanceId: "inst_isolated", ownerId: "user_isolated" });

  const volumeCreate = calls.find((args) => (
    args[0] === "volume"
    && args[1] === "create"
    && args.at(-1) === "test-data-inst_isolated"
  ));
  assert.ok(volumeCreate);
  const volumeLabels = labelValues(volumeCreate);
  for (const prefix of ["io.openapp.portal", "io.sample-app.portal"]) {
    assert.equal(volumeLabels[`${prefix}.managed`], "true");
    assert.equal(volumeLabels[`${prefix}.instance-id`], "inst_isolated");
    assert.equal(volumeLabels[`${prefix}.owner-id`], "user_isolated");
    assert.equal(volumeLabels[`${prefix}.storage-ref`], "workspace-storage:inst_isolated");
  }
  const privateNetworkCreate = calls.find((args) => args[0] === "network" && args[1] === "create" && args.at(-1) === "test-net-inst_isolated");
  const egressNetworkCreate = calls.find((args) => args[0] === "network" && args[1] === "create" && args.at(-1) === "test-net-inst_isolated-egress");
  assert.ok(privateNetworkCreate);
  assert.ok(egressNetworkCreate);
  assert.ok(privateNetworkCreate.includes("--internal"));
  assert.ok(privateNetworkCreate.includes("--subnet"));
  assert.ok(egressNetworkCreate.includes("com.docker.network.bridge.enable_icc=false"));
  assert.ok(egressNetworkCreate.includes("--subnet"));
  assert.notEqual(
    privateNetworkCreate[privateNetworkCreate.indexOf("--subnet") + 1],
    egressNetworkCreate[egressNetworkCreate.indexOf("--subnet") + 1],
  );
  assert.ok(calls.some((args) => args.join(" ") === "network connect test-net-inst_isolated-egress test-user-inst_isolated"));
  assert.ok(calls.some((args) => args.join(" ") === "network connect test-net-inst_isolated portal-control-plane"));
  const runArgs = calls.find((args) => args[0] === "create");
  assert.ok(runArgs);
  assert.equal(runArgs[runArgs.indexOf("--network") + 1], "test-net-inst_isolated");
  assert.equal(runArgs.includes("--publish"), false);
});

test("provision consumes the resolved StorageBinding and labels its managed Volume", async () => {
  const instanceId = "inst_bound_storage";
  const ownerId = "user_bound_storage";
  const attachmentRef = "provider-volume-bound-storage";
  const calls: string[][] = [];
  let containerExists = false;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      if (!containerExists) throw new Error("No such container");
      return { stdout: inspect(instanceId, ownerId), stderr: "" };
    }
    if ((args[0] === "volume" || args[0] === "network") && args[1] === "inspect") {
      throw new Error(`No such ${args[0]}`);
    }
    if (args[0] === "create") containerExists = true;
    return { stdout: "", stderr: "" };
  });

  await runtime.provision({
    instanceId,
    ownerId,
    storageBindings: [storageBinding(instanceId, attachmentRef)],
  });

  const volumeCreate = calls.find((args) => args[0] === "volume" && args[1] === "create");
  assert.ok(volumeCreate);
  assert.equal(volumeCreate.at(-1), attachmentRef);
  assert.equal(labelValues(volumeCreate)["io.sample-app.portal.storage-ref"], `workspace-storage:${instanceId}`);
  const containerCreate = calls.find((args) => args[0] === "create");
  assert.ok(containerCreate);
  assert.ok(containerCreate.includes(`type=volume,source=${attachmentRef},target=/var/lib/sample-app`));
  assert.equal(calls.some((args) => args.includes(`test-data-${instanceId}`)), false);
});

test("provision rejects an unsafe or mismatched StorageBinding before Docker side effects", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(runtime.provision({
    instanceId: "inst_unsafe_storage",
    ownerId: "user_unsafe_storage",
    storageBindings: [{
      ...storageBinding("inst_unsafe_storage"),
      attachmentRef: "/tmp/host-symlink",
    }],
  }), /workspace storage attachment is unsafe/u);
  await assert.rejects(runtime.provision({
    instanceId: "inst_mismatched_storage",
    ownerId: "user_mismatched_storage",
    storageBindings: [{
      ...storageBinding("inst_mismatched_storage"),
      storageId: "workspace-storage:someone-else",
    }],
  }), /workspace storage identity mismatch/u);
  assert.deepEqual(calls, []);
});

test("bound storage fails closed when any Docker Volume ownership label is missing or wrong", async (t) => {
  const instanceId = "inst_storage_labels";
  const ownerId = "user_storage_labels";
  const attachmentRef = "provider-data-storage-labels";
  const baseLabels = {
    "io.sample-app.portal.managed": "true",
    "io.sample-app.portal.instance-id": instanceId,
    "io.sample-app.portal.owner-id": ownerId,
    "io.sample-app.portal.storage-ref": `workspace-storage:${instanceId}`,
  };
  const variants: Array<[string, Record<string, string>]> = [
    ["managed", { ...baseLabels, "io.sample-app.portal.managed": "false" }],
    ["instance", { ...baseLabels, "io.sample-app.portal.instance-id": "another-workspace" }],
    ["owner", { ...baseLabels, "io.sample-app.portal.owner-id": "another-owner" }],
    ["storageRef", { ...baseLabels, "io.sample-app.portal.storage-ref": "workspace-storage:another" }],
  ];
  const { ["io.sample-app.portal.storage-ref"]: _storageRef, ...missingStorageRef } = baseLabels;
  variants.push(["missing storageRef", missingStorageRef]);

  for (const [name, labels] of variants) {
    await t.test(name, async () => {
      const calls: string[][] = [];
      const runtime = new DockerCliRuntime(config, async (_binary, args) => {
        calls.push([...args]);
        if (isContainerInspect(args)) return { stdout: inspect(instanceId, ownerId), stderr: "" };
        if (args[0] === "volume" && args[1] === "inspect") {
          return { stdout: JSON.stringify([{ Name: attachmentRef, Labels: labels }]), stderr: "" };
        }
        throw new Error(`unexpected Docker command: ${args.join(" ")}`);
      });

      await assert.rejects(
        runtime.get(instanceId, undefined, [storageBinding(instanceId, attachmentRef)]),
        /matching ownership labels/u,
      );
      assert.equal(calls.some((args) => args[0] === "create" || args.includes("rm")), false);
    });
  }
});

test("legacy deterministic Volume remains usable but cannot be released without a storageRef label", async () => {
  const instanceId = "inst_legacy_storage";
  const ownerId = "user_legacy_storage";
  const attachmentRef = `test-data-${instanceId}`;
  const calls: string[][] = [];
  let state = "stopped";
  let storageRef: string | undefined;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      if (args[2] !== `test-user-${instanceId}`) throw new Error("No such container");
      return { stdout: inspect(instanceId, ownerId, state), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return {
        stdout: JSON.stringify([{
          Name: attachmentRef,
          Labels: {
            "io.sample-app.portal.managed": "true",
            "io.sample-app.portal.instance-id": instanceId,
            "io.sample-app.portal.owner-id": ownerId,
            ...(storageRef ? { "io.sample-app.portal.storage-ref": storageRef } : {}),
          },
        }]),
        stderr: "",
      };
    }
    if (args[0] === "start") {
      state = "running";
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  });
  const binding = storageBinding(instanceId);

  const started = await runtime.start(instanceId, undefined, [binding]);

  assert.equal(started.state, "running");
  storageRef = "workspace-storage:another-workspace";
  await assert.rejects(
    runtime.get(instanceId, undefined, [binding]),
    /matching ownership labels/u,
  );
  storageRef = undefined;
  await assert.rejects(
    runtime.releaseWorkspaceStorage({ instanceId, ownerId, storageBindings: [binding] }),
    /matching ownership labels/u,
  );
  assert.equal(calls.some((args) => args.join(" ") === `volume rm ${attachmentRef}`), false);
});

test("network mode reconnects a restarted Portal while reading an existing instance", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime({
    ...config,
    endpointMode: "network",
    portalContainer: "portal-restarted",
  }, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) return { stdout: inspect("inst_existing", "user_existing"), stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), "inst_existing", "user_existing"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });

  const instance = await runtime.get("inst_existing");

  assert.equal(instance?.endpoint, "http://test-user-inst_existing:37371");
  assert.ok(calls.some((args) => args.join(" ") === "network connect test-net-inst_existing portal-restarted"));
});

for (const recoveryCommand of [undefined, ["/bin/custom-recover", "--repair"]] as const) {
test(`removeEnvironment preserves Volume with optional recovery ${JSON.stringify(recoveryCommand)}`, async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      const name = String(args[2]);
      if (name !== "test-user-inst_3") {
        throw new Error("No such container");
      }
      return { stdout: inspect("inst_3", "user_9"), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource("test-data-inst_3", "inst_3", "user_9"), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource(String(args[2]), "inst_3", "user_9"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const { recoveryCommand: _command, lockRecoveryEnvironment, ...baseProfile } = LEGACY_RUNTIME_PROFILE_FIXTURE;
  const runtime = new DockerCliRuntime({
    ...config, endpointMode: "network", portalContainer: "portal-control-plane",
    profile: { ...baseProfile, ...(recoveryCommand ? { recoveryCommand, lockRecoveryEnvironment } : {}) },
  }, run);
  await runtime.removeEnvironment({
    instanceId: "inst_3",
    ownerId: "user_9",
    storageBindings: [storageBinding("inst_3")],
  });
  assert.ok(calls.some((args) => args.join(" ") === "rm --force test-user-inst_3"));
  assert.equal(calls.some((args) => args.join(" ") === "volume rm test-data-inst_3"), false);
  assert.ok(calls.some((args) => args.join(" ") === "network disconnect --force test-net-inst_3 portal-control-plane"));
  assert.ok(calls.some((args) => args.join(" ") === "network rm test-net-inst_3"));
  assert.ok(calls.some((args) => args.join(" ") === "network rm test-net-inst_3-egress"));
  const recovery = calls.filter((args) => args[0] === "run");
  assert.equal(recovery.length, recoveryCommand ? 1 : 0);
  if (recoveryCommand) {
    assert.equal(recovery[0]![recovery[0]!.indexOf("--entrypoint") + 1], "/bin/custom-recover");
    assert.equal(recovery[0]!.at(-1), "--repair");
    assert.ok(!recovery[0]!.includes("node"));
  }
});
}

test("removeEnvironment fences every Environment generation before deleting its containers", async () => {
  const calls: string[][] = [];
  const instanceId = "inst_remove_fencing";
  const ownerId = "user_remove_fencing";
  const canonicalName = `test-user-${instanceId}`;
  const containerNames = [
    canonicalName,
    `${canonicalName}-rebuild-next`,
    `${canonicalName}-rebuild-previous`,
    `${canonicalName}-rebuild-rollback`,
  ];
  const containerIds = containerNames.map((_name, index) => String(index + 1).repeat(64));
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      const index = containerNames.indexOf(String(args[2]));
      if (index < 0) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, index === 0 || index === 3 ? "running" : "exited", {
          id: containerIds[index]!,
          hostname: containerIds[index]!.slice(0, 12),
        }),
        stderr: "",
      };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") throw new Error("No such network");
    return { stdout: "", stderr: "" };
  });

  await runtime.removeEnvironment({
    instanceId,
    ownerId,
    storageBindings: [storageBinding(instanceId)],
  });

  const commandLines = calls.map((args) => args.join(" "));
  const firstStop = commandLines.findIndex((line) => line.startsWith("stop --time 30 "));
  const recovery = calls.findIndex((args) => (
    args[0] === "run"
    && args.includes(`SAMPLE_APP_STATE_LOCK_RECOVER_CONTAINERS=${containerIds.join(",")}`)
    && args.includes(`SAMPLE_APP_STATE_LOCK_RECOVER_HOSTS=${containerIds.map((id) => id.slice(0, 12)).join(",")}`)
    && args.at(-1) === "/opt/sample-app/recover-state-locks.mjs"
  ));
  const firstRemoval = commandLines.findIndex((line) => line.startsWith("rm --force "));

  assert.deepEqual(
    commandLines.filter((line) => line.startsWith("stop --time 30 ")),
    containerNames.map((name) => `stop --time 30 ${name}`),
  );
  assert.ok(firstStop >= 7, "all container, Volume, and Network ownership checks must finish before stopping");
  assert.ok(recovery > firstStop, "state locks can be recovered only after every generation is stopped");
  assert.ok(firstRemoval > recovery, "containers can be deleted only after state-lock recovery succeeds");
  assert.equal(commandLines.some((line) => line === `volume rm test-data-${instanceId}`), false);
});

test("legacy container discovery is retained when label listing returns no additional candidates", async () => {
  const instanceId = "inst_legacy_alias";
  const ownerId = "user_legacy_alias";
  const legacyName = `sample-app-user-${instanceId}`;
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime({
    ...config,
    resourceDiscovery: true,
  }, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      if (args[2] !== legacyName) throw new Error("No such container");
      return {
        stdout: inspect(instanceId, ownerId, "stopped", { hostname: "legacy-host" }),
        stderr: "",
      };
    }
    if (args[0] === "ps") return { stdout: "", stderr: "" };
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  });

  const discovered = await runtime.get(instanceId);

  assert.equal(discovered?.ownerId, ownerId);
  assert.equal(discovered?.runtimeId, "1290c0ae578d0000000000000000000000000000000000000000000000000000");
  const inspectedNames = calls
    .filter((args) => isContainerInspect(args))
    .map((args) => String(args[2]));
  assert.ok(inspectedNames.includes(legacyName));
  assert.equal(calls.some((args) => args[0] === "ps"), true);
});

test("removeEnvironment preserves cancellation while stopping an Environment", async () => {
  const calls: string[][] = [];
  const instanceId = "inst_remove_cancelled";
  const ownerId = "user_remove_cancelled";
  const controller = new AbortController();
  const cancellation = new Error("container not found during cancellation");
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      if (args[2] !== `test-user-${instanceId}`) throw new Error("No such container");
      return { stdout: inspect(instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource(`test-data-${instanceId}`, instanceId, ownerId), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") throw new Error("No such network");
    if (args[0] === "stop") {
      controller.abort(cancellation);
      throw cancellation;
    }
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(runtime.removeEnvironment({
    instanceId,
    ownerId,
    storageBindings: [storageBinding(instanceId)],
    signal: controller.signal,
  }), (error: unknown) => error === cancellation);

  const stopIndex = calls.findIndex((args) => args[0] === "stop");
  assert.ok(stopIndex >= 0);
  assert.deepEqual(calls.slice(stopIndex + 1), []);
});

test("releaseWorkspaceStorage removes only the validated binding and treats an absent Volume as success", async () => {
  const calls: string[][] = [];
  let volumePresent = true;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === "volume" && args[1] === "inspect") {
      if (!volumePresent) throw new Error("No such volume");
      return { stdout: managedResource("test-data-inst_release", "inst_release", "user_release"), stderr: "" };
    }
    if (args.join(" ") === "volume rm test-data-inst_release") {
      volumePresent = false;
      return { stdout: "", stderr: "" };
    }
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  });
  const request = {
    instanceId: "inst_release",
    ownerId: "user_release",
    storageBindings: [storageBinding("inst_release")],
  };

  await runtime.releaseWorkspaceStorage(request);
  await runtime.releaseWorkspaceStorage(request);

  assert.equal(calls.filter((args) => args.join(" ") === "volume rm test-data-inst_release").length, 1);
  assert.equal(calls.some((args) => args[0] === "rm" || args[0] === "network"), false);
});

test("remove refuses resources whose ownership labels do not match the instance", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      if (args[2] !== "test-user-inst_guarded") throw new Error("No such container");
      return { stdout: inspect("inst_guarded", "user_owner"), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource("test-data-inst_guarded", "inst_guarded", "user_attacker"), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return { stdout: managedResource("test-net-inst_guarded", "inst_guarded", "user_owner"), stderr: "" };
    }
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(runtime.removeEnvironment({
    instanceId: "inst_guarded",
    ownerId: "user_owner",
    storageBindings: [storageBinding("inst_guarded")],
  }), /matching ownership labels/u);
  assert.equal(calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
});

test("remove compares resource ownership with the control-plane owner", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime({ ...config, endpointMode: "network", portalContainer: "portal-control-plane" }, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      if (args[2] !== "test-user-inst_owner_guard") throw new Error("No such container");
      return { stdout: inspect("inst_owner_guard", "user_expected"), stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "inspect") return { stdout: managedResource("test-data-inst_owner_guard", "inst_owner_guard", "user_attacker"), stderr: "" };
    if (args[0] === "network" && args[1] === "inspect") return { stdout: managedResource("test-net-inst_owner_guard", "inst_owner_guard", "user_attacker"), stderr: "" };
    return { stdout: "", stderr: "" };
  });

  await assert.rejects(runtime.removeEnvironment({
    instanceId: "inst_owner_guard",
    ownerId: "user_expected",
    storageBindings: [storageBinding("inst_owner_guard")],
  }), /matching ownership labels/u);
  assert.equal(calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
});

test("removeEnvironment validates every rebuild artifact before deleting the canonical Environment", async () => {
  const calls: string[][] = [];
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    calls.push([...args]);
    if (isContainerInspect(args)) {
      const name = String(args[2]);
      if (name === "test-user-inst_artifact_guard") {
        return { stdout: inspect("inst_artifact_guard", "user_expected"), stderr: "" };
      }
      if (name.endsWith("-rebuild-previous")) {
        return { stdout: inspect("inst_artifact_guard", "user_attacker"), stderr: "" };
      }
      throw new Error("No such container");
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return { stdout: managedResource("test-data-inst_artifact_guard", "inst_artifact_guard", "user_expected"), stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") throw new Error("No such network");
    throw new Error(`unexpected Docker command: ${args.join(" ")}`);
  });

  await assert.rejects(runtime.removeEnvironment({
    instanceId: "inst_artifact_guard",
    ownerId: "user_expected",
    storageBindings: [storageBinding("inst_artifact_guard")],
  }), /ownership mismatch/u);

  assert.equal(calls.some((args) => args[0] === "rm" || args[1] === "rm"), false);
});

test("loadImage tags the single image from an archive with the requested reference", async () => {
  const calls: string[][] = [];
  const run: CommandRunner = async (_binary, args) => {
    calls.push([...args]);
    return {
      stdout: args[0] === "load" ? "Loaded image: archive/source:old\n" : "",
      stderr: "",
    };
  };
  const runtime = new DockerCliRuntime(config, run);
  await runtime.loadImage("/tmp/image.tar", "registry.example.com/openapp:v1");
  assert.deepEqual(calls, [
    ["load", "--input", "/tmp/image.tar"],
    ["tag", "archive/source:old", "registry.example.com/openapp:v1"],
  ]);
});

test("loadImage refuses to manufacture a digest reference with docker tag", async () => {
  const digest = `registry.example.com/openapp@sha256:${"b".repeat(64)}`;
  const runtime = new DockerCliRuntime(config, async (_binary, args) => ({
    stdout: args[0] === "load" ? "Loaded image: registry.example.com/openapp:v1\n" : "",
    stderr: "",
  }));
  await assert.rejects(
    runtime.loadImage("/tmp/image.tar", digest),
    /does not contain the requested digest/u,
  );
});

test("loadImage rejects an archive containing multiple tagged images", async () => {
  const runtime = new DockerCliRuntime(config, async () => ({
    stdout: "Loaded image: source/one:v1\nLoaded image: source/two:v1\n",
    stderr: "",
  }));
  await assert.rejects(
    runtime.loadImage("/tmp/image.tar", "registry.example.com/openapp:v1"),
    /exactly one tagged image/u,
  );
});

test("rejects browser-shaped or shell-shaped identifiers", async () => {
  const runtime = new DockerCliRuntime(config, async () => ({ stdout: "[]", stderr: "" }));
  await assert.rejects(
    runtime.provision({ instanceId: "../../host", ownerId: "user_7" }),
    /server-issued identifier/,
  );
  await assert.rejects(
    runtime.provision({ instanceId: "inst_1", ownerId: "user 7; docker rm" }),
    /server-issued identifier/,
  );
});

test("rejects an app label outside the catalog identifier grammar", async () => {
  const runtime = new DockerCliRuntime(config, async (_binary, args) => {
    if (isContainerInspect(args) || (args[0] === "network" || args[0] === "volume") && args[1] === "inspect") {
      throw new Error(`No such ${args[0]}`);
    }
    return { stdout: "", stderr: "" };
  });
  await assert.rejects(
    runtime.provision({ instanceId: "inst_app_id", ownerId: "user_app_id", appId: "A_bad" }),
    /normalized catalog identifier/u,
  );
});
