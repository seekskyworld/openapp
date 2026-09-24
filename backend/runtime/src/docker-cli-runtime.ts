import { randomUUID } from "node:crypto";
import { withRuntimeCleanup } from "./runtime-cleanup.js";
import {
  ContainerArtifactValidationError,
  ContainerRebuildRollbackError,
  GENERIC_RUNTIME_CONTRACT,
  NO_RUNTIME_CONTRACT,
  type ContainerActivityMetrics,
  type ContainerCatalogSnapshot,
  type ContainerFailureDiagnostics,
  type ContainerInstance,
  type ContainerLaunchProfile,
  type ContainerRebuildTransactionInspection,
  type ContainerRebuildTransactionStatus,
  type ContainerRuntime,
  type ProvisionContainerRequest,
  type ReleaseContainerStorageRequest,
  type RemoveContainerEnvironmentRequest,
  type ResolveStorageBindingRequest,
  type StorageBinding,
} from "./container-runtime.js";
import {
  CONFIG_FILES_MAX_BYTES,
  CONFIG_PATH_PATTERN,
  DEFAULT_RESOURCE_SCHEME,
  DockerContainerCleanupError,
  ENVIRONMENT_CONTROL_PATTERN,
  ENVIRONMENT_MAX_BYTES,
  ENVIRONMENT_MAX_ENTRIES,
  ENVIRONMENT_NAME_PATTERN,
  ENVIRONMENT_VALUE_MAX_BYTES,
  IDENTIFIER_PATTERN,
  IMAGE_PATTERN,
  IMAGE_SMOKE_HEALTH_PROBE,
  REBUILD_ARTIFACT_SUFFIX,
  RUNTIME_COMMAND_TIMEOUT_MS,
  RUNTIME_LONG_COMMAND_TIMEOUT_MS,
  RUNTIME_PROBE_TIMEOUT_MS,
  RUNTIME_STOP_TIMEOUT_MS,
  catalogSnapshotLabelArgs,
  catalogSnapshotMetadata,
  dockerCliRuntimeConfigFromEnv,
  execFileAsync,
  formatIpv4Address,
  isMissingDockerResourceError,
  isRebuildArtifactName,
  isUnsupportedResourceDiscoveryError,
  mapState,
  normalizeDockerContainerHostnames,
  parseDockerStats,
  parseNetworkPool,
  parseResourceNameList,
  readDockerContainerHostname,
  rebuildMetadata,
  requireAppId,
  requireDockerContainerId,
  requireIdentifier,
  resolveRuntimeEnvironment,
  sanitizedDockerCommandError,
  stableHash,
  validMemory,
  type CommandResult,
  type CommandRunner,
  type DockerCliRuntimeConfig,
  type DockerInspect,
  type DockerManagedResourceInspect,
  type DockerStats,
  type IPv4NetworkPool,
  type InspectedContainer,
  type NetworkPolicy,
  type RebuildArtifactNames,
  type RebuildArtifacts,
  type RebuildContainerMetadata,
  type RebuildCutoverProgress,
  type RebuildPreparation,
  type RebuildRecoveryContext,
  type StagedRebuildTransaction,
} from "./docker-runtime-support.js";
import {
  ManagedResourceResolutionError,
  inferManagedNetworkRole,
  resourceLabel,
  resourceLabelArgs,
  selectManagedResource,
  type ManagedNetworkRole,
  type ManagedResourceIdentity,
  type ManagedResourceKind,
  type ManagedResourceRef,
} from "./managed-resource-resolver.js";
import { isRuntimeReservedEnvironmentName, runtimeReservedEnvironmentNames } from "./runtime-environment.js";
import { GENERIC_RUNTIME_PROFILE, validateRuntimeProfile, type RuntimeProfile } from "./runtime-profile.js";
export { dockerCliRuntimeConfigFromEnv } from "./docker-runtime-support.js";
export type {
  CommandResult,
  CommandRunner,
  CommandRunnerOptions,
  DockerCliRuntimeConfig,
  DockerCliRuntimeConfigOptions,
} from "./docker-runtime-support.js";
export class DockerCliRuntime implements ContainerRuntime {
  readonly #config: DockerCliRuntimeConfig;
  readonly #networkPool: IPv4NetworkPool;
  readonly #run: CommandRunner;
  readonly #randomId: () => string;
  /**
   * 进程内缓存仅保存已通过标签校验的实际名称，不承担持久化身份职责。
   * Portal 重启后会重新走解析器，因此配置切换不会把旧名称永久写死。
   */
  readonly #resolvedResourceRefs = new Map<string, ManagedResourceRef>();

  #profile(): RuntimeProfile {
    return this.#config.profile ?? GENERIC_RUNTIME_PROFILE;
  }

  #portKey(): string {
    return `${this.#profile().containerPort}/tcp`;
  }

  #envName(kind: "config" | "containers" | "hosts" | "recoveryId"): string {
    const profile = this.#profile();
    if (kind === "config") return profile.configEnvironmentKey;
    if (!profile.lockRecoveryEnvironment) throw new Error("runtime recovery capability is not configured");
    if (kind === "containers") return profile.lockRecoveryEnvironment.containers;
    if (kind === "hosts") return profile.lockRecoveryEnvironment.hosts;
    return profile.lockRecoveryEnvironment.recoveryId;
  }

  #labelPrefix(): string {
    return this.#profile().labelPrefix;
  }

  #labelPrefixes(): readonly string[] {
    return [...new Set([this.#labelPrefix(), ...(this.#config.legacyLabelPrefixes ?? [])])];
  }

  constructor(
    config: DockerCliRuntimeConfig = dockerCliRuntimeConfigFromEnv(),
    run: CommandRunner = async (binary, args, options) => {
      try {
        const result = await execFileAsync(binary, [...args], {
          maxBuffer: 10 * 1024 * 1024,
          // 大镜像的 pull/load 可能持续数分钟；短探针和生命周期命令使用更短的
          // 截止时间。
          timeout: options?.timeoutMs ?? RUNTIME_COMMAND_TIMEOUT_MS,
          killSignal: "SIGKILL",
          signal: options?.signal,
        });
        return { stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        options?.signal?.throwIfAborted();
        throw sanitizedDockerCommandError(args, error);
      }
    },
    randomId: () => string = randomUUID,
  ) {
    const profile = config.profile ?? GENERIC_RUNTIME_PROFILE;
    validateRuntimeProfile(profile);
    if (config.probeImage !== undefined && !IMAGE_PATTERN.test(config.probeImage))
      throw new Error("runtime probe image is invalid");
    const legacyPrefixes = profile.legacyResourcePrefixes;
    this.#config = {
      ...config,
      profile,
      legacyLabelPrefixes: config.legacyLabelPrefixes ?? legacyPrefixes?.label ?? [],
      legacyNetworkPrefixes: config.legacyNetworkPrefixes ?? legacyPrefixes?.network ?? [],
      legacyNamePrefixes: config.legacyNamePrefixes ?? legacyPrefixes?.container ?? [],
      legacyVolumePrefixes: config.legacyVolumePrefixes ?? legacyPrefixes?.volume ?? [],
      runtimeEnvironment: resolveRuntimeEnvironment(config, profile),
    };
    this.#networkPool = parseNetworkPool(
      config.networkPoolCidr,
      config.networkSubnetPrefix,
      profile.environmentPrefix ?? "OPENAPP",
    );
    this.#run = run;
    this.#randomId = randomId;
  }

  async resolveStorageBinding(request: ResolveStorageBindingRequest): Promise<StorageBinding> {
    const workspaceId = requireIdentifier(request.workspaceId, "workspaceId");
    requireIdentifier(request.ownerId, "ownerId");
    request.signal?.throwIfAborted();
    if (request.storageId !== `workspace-storage:${workspaceId}`) {
      throw new Error("workspace storage identity mismatch");
    }
    if (request.storageClass !== this.#profile().storageClass) {
      throw new Error("workspace storage class is unsupported");
    }
    if (request.affinityProviderId !== undefined && request.affinityProviderId !== "docker") {
      throw new Error("workspace storage Provider affinity mismatch");
    }
    if (request.affinityRegion !== undefined) {
      throw new Error("workspace storage region affinity is unsupported");
    }
    return {
      storageId: request.storageId,
      attachmentRef: this.#volumeName(workspaceId),
      mountPath: this.#profile().storageMountPath,
      readOnly: false,
    };
  }

  async provision(request: ProvisionContainerRequest): Promise<ContainerInstance> {
    const instanceId = requireIdentifier(request.instanceId, "instanceId");
    const ownerId = requireIdentifier(request.ownerId, "ownerId");
    const storageBinding = this.#workspaceStorageBinding(instanceId, request.storageBindings);
    const boundStorage = request.storageBindings === undefined ? undefined : [storageBinding];
    const signal = request.signal;
    signal?.throwIfAborted();
    if (request.appId) requireAppId(request.appId);
    const shouldStart = request.start !== false;
    const existing = await this.#get(instanceId, signal, boundStorage);
    if (existing) {
      if (existing.ownerId !== ownerId) throw new Error("container ownership mismatch");
      return !shouldStart || existing.state === "running"
        ? existing
        : this.start(instanceId, signal, boundStorage);
    }

    const profile = this.#launchProfile(request);
    await this.#createContainer(
      instanceId,
      ownerId,
      profile,
      this.#containerName(instanceId),
      shouldStart,
      request,
      storageBinding,
      undefined,
      signal,
    );
    return this.#require(instanceId, signal);
  }

  async #createContainer(
    instanceId: string,
    ownerId: string,
    profile: ContainerLaunchProfile,
    name: string,
    shouldStart: boolean,
    request: ProvisionContainerRequest,
    storageBinding: StorageBinding,
    rebuild?: RebuildContainerMetadata,
    signal?: AbortSignal,
    authorizedContainerHosts: readonly string[] = [],
  ): Promise<string | null> {
    const volumeName = await this.#ensureManagedVolume(
      storageBinding.attachmentRef,
      instanceId,
      ownerId,
      storageBinding.storageId,
      signal,
    );
    const privateNetworkName = await this.#ensureManagedNetwork(
      this.#networkName(instanceId),
      instanceId,
      ownerId,
      ["--internal"],
      "private",
      signal,
    );
    const egressNetworkName = await this.#ensureManagedNetwork(
      this.#egressNetworkName(instanceId),
      instanceId,
      ownerId,
      ["--opt", "com.docker.network.bridge.enable_icc=false"],
      "egress",
      signal,
    );
    // 环境变量为空时不能保留孤立的 `--env`；Docker 会把后续镜像名当成
    // 环境变量值，从而返回误导性的 `invalid reference format`。
    const runtimeEnvironmentArgs = Object.entries(this.#config.runtimeEnvironment ?? {}).flatMap(
      ([key, value]) => ["--env", `${key}=${value}`],
    );
    const args = [
      "create",
      "--name",
      name,
      "--network",
      privateNetworkName,
      ...this.#containerLabelArgs(instanceId, ownerId, request, rebuild),
      "--mount",
      `type=volume,source=${volumeName},target=${storageBinding.mountPath}`,
      "--memory",
      profile.resources.memory,
      "--cpus",
      profile.resources.cpus,
      "--pids-limit",
      String(profile.resources.pidsLimit),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--restart",
      "no",
      ...runtimeEnvironmentArgs,
    ];
    const mcpEnvironmentKey = this.#profile().providerEnvironment?.mcpAppSandboxOriginKey;
    if (
      this.#config.mcpAppSandboxOrigin &&
      mcpEnvironmentKey &&
      !Object.hasOwn(this.#config.runtimeEnvironment ?? {}, mcpEnvironmentKey)
    ) {
      args.push("--env", `${mcpEnvironmentKey}=${this.#config.mcpAppSandboxOrigin}`);
    }
    if (rebuild && this.#profile().recoveryCommand) {
      args.push("--env", `${this.#envName("containers")}=${rebuild.predecessorId}`);
      const hostnames = normalizeDockerContainerHostnames(authorizedContainerHosts);
      if (hostnames.length > 0) {
        args.push("--env", `${this.#envName("hosts")}=${hostnames.join(",")}`);
      }
      args.push("--env", `${this.#envName("recoveryId")}=${rebuild.id}`);
    }
    for (const [key, value] of Object.entries(profile.environment).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      args.push("--env", `${key}=${value}`);
    }
    if (profile.configFiles.length) {
      args.push("--env", `${this.#envName("config")}=${JSON.stringify(profile.configFiles)}`);
    }
    if (this.#config.endpointMode === "loopback") {
      args.push("--publish", `127.0.0.1::${this.#profile().containerPort}`);
    }
    args.push(profile.imageReference);
    const created = await this.#docker(args, signal);
    const createdId = /^[a-f0-9]{64}$/u.test(created.stdout.trim())
      ? requireDockerContainerId(created.stdout.trim())
      : null;
    try {
      await this.#docker(["network", "connect", egressNetworkName, name], signal);
      if (shouldStart) await this.#docker(["start", name], signal);
    } catch (error) {
      await this.#cleanupFailedContainerCreation(name, rebuild ? "rebuild-candidate" : "provision", signal);
      throw error;
    }
    return createdId;
  }

  async #cleanupFailedContainerCreation(
    name: string,
    purpose: "provision" | "rebuild-candidate",
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.#docker(["rm", "--force", name], signal);
    } catch {
      if (signal?.aborted) throw signal.reason;
      // 清理失败意味着受管候选可能仍然存在，必须显式上报；固定错误码
      // 不携带 runner 的原始 argv 或 stderr，避免可观测性重新引入泄漏。
      throw new DockerContainerCleanupError(
        purpose === "provision"
          ? "runtime_provision_container_cleanup_failed"
          : "runtime_rebuild_candidate_container_cleanup_failed",
      );
    }
  }

  async get(
    instanceId: string,
    signal?: AbortSignal,
    storageBindings?: readonly StorageBinding[],
  ): Promise<ContainerInstance | null> {
    return this.#get(instanceId, signal, storageBindings);
  }

  async observe(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance | null> {
    requireIdentifier(instanceId, "instanceId");
    signal?.throwIfAborted();
    const instance = await this.#inspectContainer(instanceId, signal);
    if (instance && this.#config.endpointMode === "network") {
      // Reconnecting the Portal to an existing private network is the one
      // idempotent infrastructure side effect required by a read after a
      // Portal restart. It does not touch the user container or rebuild state.
      await this.#inspectManagedResource(
        "network",
        this.#networkName(instanceId),
        instanceId,
        instance.ownerId,
        "private",
        signal,
      );
      await this.#connectPortal(instanceId, signal);
    }
    return instance;
  }

  async inspectRebuildTransaction(
    instanceId: string,
    transactionId: string,
    signal?: AbortSignal,
  ): Promise<ContainerRebuildTransactionInspection> {
    requireIdentifier(instanceId, "instanceId");
    requireIdentifier(transactionId, "rebuildId");
    const artifacts = await this.#inspectRebuildArtifacts(instanceId, signal);
    return {
      status: this.#rebuildTransactionStatus(artifacts, transactionId),
      instance: artifacts.canonical ?? artifacts.previous,
    };
  }

  async #get(
    instanceId: string,
    signal?: AbortSignal,
    storageBindings?: readonly StorageBinding[],
  ): Promise<InspectedContainer | null> {
    requireIdentifier(instanceId, "instanceId");
    const storageBinding = this.#workspaceStorageBinding(instanceId, storageBindings);
    let instance = await this.#inspectContainer(instanceId, signal);
    if (instance && storageBindings !== undefined) {
      const volume = await this.#inspectManagedResource(
        "volume",
        storageBinding.attachmentRef,
        instanceId,
        instance.ownerId,
        undefined,
        signal,
        storageBinding.storageId,
        this.#allowsLegacyStorageRef(instanceId, storageBinding),
      );
      if (!volume) {
        throw new ManagedResourceResolutionError(
          "provider_resource_missing",
          {
            instanceId,
            ownerId: instance.ownerId,
            storageId: storageBinding.storageId,
            ...(this.#allowsLegacyStorageRef(instanceId, storageBinding)
              ? { allowLegacyStorageRef: true }
              : {}),
          },
          "volume",
          [storageBinding.attachmentRef],
        );
      }
    }
    let recoveredCatalogSnapshot: ContainerCatalogSnapshot | undefined;
    let rebuildRecovered = false;
    // 只有发现受管 rebuild 标签或 canonical 缺失时才扫描旁路名称，避免
    // 普通健康查询改变现有调用的 Docker 行为。崩溃窗口中的 candidate
    // 必须先经过同一事务恢复，再允许 Lifecycle 把 Runtime 快照写回数据库。
    if (instance?.rebuild) {
      const canonicalName = this.#containerName(instanceId);
      const previous = await this.#inspectContainerByName(
        `${canonicalName}-rebuild-previous`,
        instanceId,
        signal,
      );
      const [candidate, rollback] = previous
        ? [null, null]
        : await Promise.all([
            this.#inspectContainerByName(`${canonicalName}-rebuild-next`, instanceId, signal),
            this.#inspectContainerByName(`${canonicalName}-rebuild-rollback`, instanceId, signal),
          ]);
      // Candidate labels are immutable and intentionally remain on the
      // canonical container. Once the predecessor no longer exists, the
      // transaction has crossed its verifiable commit boundary only when no
      // side artifact remains to authorize recovery.
      if (previous || candidate || rollback) {
        recoveredCatalogSnapshot = await this.#recoverRebuildArtifacts(
          instanceId,
          instance.ownerId,
          false,
          true,
          signal,
          storageBinding,
        );
        rebuildRecovered = true;
        instance = await this.#inspectContainer(instanceId, signal);
      }
    } else {
      const canonicalName = this.#containerName(instanceId);
      const rollback = await this.#inspectContainerByName(
        `${canonicalName}-rebuild-rollback`,
        instanceId,
        signal,
      );
      if (rollback?.rebuild) {
        recoveredCatalogSnapshot = await this.#recoverRebuildArtifacts(
          instanceId,
          rollback.ownerId,
          false,
          true,
          signal,
          storageBinding,
        );
        rebuildRecovered = true;
        instance = await this.#inspectContainer(instanceId, signal);
      } else if (!instance || instance.state !== "running") {
        const [candidate, previous] = await Promise.all([
          this.#inspectContainerByName(`${canonicalName}-rebuild-next`, instanceId, signal),
          this.#inspectContainerByName(`${canonicalName}-rebuild-previous`, instanceId, signal),
        ]);
        const staged = candidate ?? previous;
        if (staged) {
          recoveredCatalogSnapshot = await this.#recoverRebuildArtifacts(
            instanceId,
            staged.ownerId,
            false,
            true,
            signal,
            storageBinding,
          );
          rebuildRecovered = true;
          instance = await this.#inspectContainer(instanceId, signal);
        }
      }
    }
    if (instance && recoveredCatalogSnapshot) {
      instance = { ...instance, catalogSnapshot: recoveredCatalogSnapshot, rebuildRecovered };
    } else if (instance && rebuildRecovered) {
      instance = { ...instance, rebuildRecovered };
    }
    if (instance && this.#config.endpointMode === "network") {
      const network = await this.#inspectManagedResource(
        "network",
        this.#networkName(instanceId),
        instanceId,
        instance.ownerId,
        "private",
        signal,
      );
      if (!network) {
        throw new ManagedResourceResolutionError(
          "provider_resource_missing",
          { instanceId, ownerId: instance.ownerId, networkRole: "private" },
          "network",
          [this.#networkName(instanceId)],
        );
      }
      const egressNetwork = await this.#inspectManagedResource(
        "network",
        this.#egressNetworkName(instanceId),
        instanceId,
        instance.ownerId,
        "egress",
        signal,
      );
      if (!egressNetwork) {
        throw new ManagedResourceResolutionError(
          "provider_resource_missing",
          { instanceId, ownerId: instance.ownerId, networkRole: "egress" },
          "network",
          [this.#egressNetworkName(instanceId)],
        );
      }
      await this.#connectPortal(instanceId, signal);
    }
    return instance;
  }

  async start(
    instanceId: string,
    signal?: AbortSignal,
    storageBindings?: readonly StorageBinding[],
  ): Promise<ContainerInstance> {
    requireIdentifier(instanceId, "instanceId");
    const storageBinding = this.#workspaceStorageBinding(instanceId, storageBindings);
    const boundStorage = storageBindings === undefined ? undefined : [storageBinding];
    signal?.throwIfAborted();
    await this.get(instanceId, signal, boundStorage);
    const canonicalName = this.#containerName(instanceId);
    const previousName = `${canonicalName}-rebuild-previous`;
    const rollbackName = `${canonicalName}-rebuild-rollback`;
    const [canonical, previous] = await Promise.all([
      this.#inspectContainerByName(canonicalName, instanceId, signal),
      this.#inspectContainerByName(previousName, instanceId, signal),
    ]);
    if (!canonical) throw new Error(`container ${instanceId} disappeared during the operation`);
    if (previous) {
      const stagedRebuild = this.#requireStagedReplacement(canonical, previous);
      if (previous.state === "running") throw new Error("rebuild predecessor is still running");
      try {
        if (canonical.state !== "running") await this.#docker(["start", canonicalName], signal);
        await this.#probeContainerHealth(canonicalName, signal);
        await this.#removeRebuildPredecessor(
          instanceId,
          canonical.ownerId,
          canonical.runtimeId,
          stagedRebuild,
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        try {
          await this.#fenceFailedCandidate(
            instanceId,
            canonical.ownerId,
            canonicalName,
            rollbackName,
            canonical.runtimeId,
            canonical.rebuild?.id ?? `rollback-${instanceId}`,
            storageBinding,
            signal,
          );
          await this.#docker(["rename", previousName, canonicalName], signal);
          await this.#docker(["start", canonicalName], signal);
          await this.#docker(["rm", "--force", rollbackName], signal);
          const recovered = await this.#require(instanceId, signal, boundStorage);
          throw new ContainerRebuildRollbackError(
            error,
            canonical.rebuild?.sourceCatalogSnapshot
              ? { ...recovered, catalogSnapshot: canonical.rebuild.sourceCatalogSnapshot }
              : recovered,
          );
        } catch (rollbackError) {
          if (rollbackError instanceof ContainerRebuildRollbackError) throw rollbackError;
          throw new AggregateError([error, rollbackError], "rebuild rollback failed");
        }
      }
      return this.#require(instanceId, signal, boundStorage);
    }
    if (canonical.state !== "running") await this.#docker(["start", canonicalName], signal);
    return this.#require(instanceId, signal, boundStorage);
  }

  async stop(instanceId: string, signal?: AbortSignal): Promise<ContainerInstance> {
    requireIdentifier(instanceId, "instanceId");
    const requestedName = this.#containerName(instanceId);
    try {
      await this.#docker(["stop", "--time", "30", requestedName], signal);
    } catch (error) {
      if (!isMissingDockerResourceError(error, "container")) throw error;
      // 新 Portal 可能首次接管旧命名方案；只有确定名称不存在时才做一次
      // 标签发现，避免正常 stop 增加额外 Docker 调用。
      const discovered = await this.#inspectContainer(instanceId, signal);
      const actualName = discovered?.resourceName ?? this.#containerName(instanceId);
      if (!discovered || actualName === requestedName) throw error;
      await this.#docker(["stop", "--time", "30", actualName], signal);
    }
    return this.#require(instanceId, signal);
  }

  async rebuild(request: ProvisionContainerRequest): Promise<ContainerInstance> {
    const preparation = await this.#prepareRebuild(request);
    if (!preparation.existing) {
      return this.provision({ ...request, launchProfile: preparation.launchProfile });
    }
    const transaction = await this.#stageRebuildCandidate(preparation, preparation.existing);
    await this.#commitStagedRebuild(transaction);
    return this.#require(preparation.instanceId, preparation.signal, preparation.boundStorage);
  }

  async acceptDeferredCandidate(
    instanceId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<"accepted" | "already_baseline" | "not_found"> {
    const expectedInstanceId = requireIdentifier(instanceId, "instanceId");
    const expectedOwnerId = requireIdentifier(ownerId, "ownerId");
    signal?.throwIfAborted();
    return this.#acceptDeferredCandidateAsBaseline(expectedInstanceId, expectedOwnerId, signal);
  }

  async #prepareRebuild(request: ProvisionContainerRequest): Promise<RebuildPreparation> {
    const instanceId = requireIdentifier(request.instanceId, "instanceId");
    const ownerId = requireIdentifier(request.ownerId, "ownerId");
    const storageBinding = this.#workspaceStorageBinding(instanceId, request.storageBindings);
    const boundStorage = request.storageBindings === undefined ? undefined : [storageBinding];
    const signal = request.signal;
    signal?.throwIfAborted();
    if (request.appId) requireAppId(request.appId);
    const recoveredCatalogSnapshot = await this.#recoverRebuildArtifacts(
      instanceId,
      ownerId,
      request.start !== false,
      false,
      signal,
      storageBinding,
    );
    let existing = await this.#get(instanceId, signal, boundStorage);
    if (existing && recoveredCatalogSnapshot) {
      existing = { ...existing, catalogSnapshot: recoveredCatalogSnapshot };
    }
    if (existing && existing.ownerId !== ownerId) throw new Error("container ownership mismatch");
    const launchProfile = this.#launchProfile(request);
    return { request, instanceId, ownerId, signal, existing, launchProfile, storageBinding, boundStorage };
  }

  async #acceptDeferredCandidateAsBaseline(
    instanceId: string,
    ownerId: string,
    signal?: AbortSignal,
  ): Promise<"accepted" | "already_baseline" | "not_found"> {
    const artifacts = await this.#inspectRebuildArtifacts(instanceId, signal);
    this.#requireRebuildArtifactOwnership(artifacts, ownerId);
    if (
      artifacts.canonical?.rebuild &&
      !artifacts.previous &&
      !artifacts.candidate &&
      !artifacts.rollback &&
      !artifacts.canonical.rebuild.startRequested &&
      artifacts.canonical.state !== "running"
    )
      return "already_baseline";
    if (!artifacts.canonical || !artifacts.previous || artifacts.candidate || artifacts.rollback)
      return "not_found";
    const rebuild = this.#requireStagedReplacement(artifacts.canonical, artifacts.previous);
    if (rebuild.startRequested || artifacts.canonical.state === "running") return "not_found";
    // 只删除已证明属于上一代的 previous。删完后 canonical 候选即成为新基线，
    // 后续 rebuild 的 predecessor 会自然指向它；用户 Volume 始终保留。
    await this.#removeRebuildPredecessor(instanceId, ownerId, artifacts.canonical.runtimeId, rebuild, signal);
    return "accepted";
  }

  async #stageRebuildCandidate(
    preparation: RebuildPreparation,
    existing: InspectedContainer,
  ): Promise<StagedRebuildTransaction> {
    const { request, instanceId, ownerId, signal, launchProfile, storageBinding } = preparation;
    // 先用私有名称创建候选代次，再触碰当前容器；候选启动或探针失败时，
    // 必须恢复旧名称和旧代次，避免共享 Volume 进入半提交状态。
    await this.#inspectManagedResource(
      "volume",
      storageBinding.attachmentRef,
      instanceId,
      ownerId,
      undefined,
      signal,
      storageBinding.storageId,
      this.#allowsLegacyStorageRef(instanceId, storageBinding),
    );
    await this.#inspectManagedResource(
      "network",
      this.#networkName(instanceId),
      instanceId,
      ownerId,
      "private",
      signal,
    );
    await this.#inspectManagedResource(
      "network",
      this.#egressNetworkName(instanceId),
      instanceId,
      ownerId,
      "egress",
      signal,
    );
    const names = this.#rebuildArtifactNames(instanceId);
    const wasRunning = existing.state === "running";
    const sourceCatalogSnapshot = existing.catalogSnapshot ?? request.sourceCatalogSnapshot;
    const rebuild: RebuildContainerMetadata = {
      id: requireIdentifier(request.rebuildTransactionId ?? this.#randomId(), "rebuildId"),
      predecessorId: requireDockerContainerId(existing.runtimeId),
      startRequested: request.start !== false,
      ...(sourceCatalogSnapshot ? { sourceCatalogSnapshot } : {}),
    };
    const createdCandidateId = await this.#createContainer(
      instanceId,
      ownerId,
      launchProfile,
      names.candidate,
      false,
      request,
      storageBinding,
      rebuild,
      signal,
      existing.containerHostname ? [existing.containerHostname] : [],
    );
    return { instanceId, ownerId, signal, names, wasRunning, rebuild, createdCandidateId, storageBinding };
  }

  async #commitStagedRebuild(transaction: StagedRebuildTransaction): Promise<void> {
    const { instanceId, ownerId, signal, names, wasRunning, rebuild, createdCandidateId, storageBinding } =
      transaction;
    const progress: RebuildCutoverProgress = { previousRenamed: false, candidateRenamed: false };
    try {
      if (wasRunning) await this.#docker(["stop", "--time", "30", names.canonical], signal);
      await this.#docker(["rename", names.canonical, names.previous], signal);
      progress.previousRenamed = true;
      await this.#docker(["rename", names.candidate, names.canonical], signal);
      progress.candidateRenamed = true;
      if (rebuild.startRequested) {
        await this.#docker(["start", names.canonical], signal);
        await this.#probeContainerHealth(names.canonical, signal);
        // 健康探针是提交边界。先提交 previous，再读取 canonical；否则
        // #require -> get 的崩溃恢复也会提交一次，真实 Docker 的第二次 rm
        // 会把已成功事务误导进 rollback。
        await this.#removeRebuildPredecessor(instanceId, ownerId, createdCandidateId, rebuild, signal);
      }
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      return this.#rollbackStagedRebuild(transaction, progress, error);
    }
  }

  async #rollbackStagedRebuild(
    transaction: StagedRebuildTransaction,
    progress: RebuildCutoverProgress,
    originalError: unknown,
  ): Promise<never> {
    const { instanceId, ownerId, signal, names, wasRunning, rebuild, createdCandidateId, storageBinding } =
      transaction;
    try {
      const failedName = progress.candidateRenamed ? names.canonical : names.candidate;
      const failedCandidateId =
        createdCandidateId ??
        (await this.#inspectContainerByName(failedName, instanceId, signal))?.runtimeId ??
        null;
      if (!failedCandidateId) {
        throw new Error("managed rebuild candidate ID is unavailable for rollback fencing");
      }
      await this.#fenceFailedCandidate(
        instanceId,
        ownerId,
        failedName,
        names.rollback,
        failedCandidateId,
        rebuild.id,
        storageBinding,
        signal,
      );
      if (progress.previousRenamed) await this.#docker(["rename", names.previous, names.canonical], signal);
      if (wasRunning) await this.#docker(["start", names.canonical], signal);
      await this.#docker(["rm", "--force", names.rollback], signal);
      const recovered = await this.#require(instanceId, signal);
      throw new ContainerRebuildRollbackError(
        originalError,
        rebuild.sourceCatalogSnapshot
          ? { ...recovered, catalogSnapshot: rebuild.sourceCatalogSnapshot }
          : recovered,
      );
    } catch (rollbackError) {
      if (rollbackError instanceof ContainerRebuildRollbackError) throw rollbackError;
      throw new AggregateError([originalError, rollbackError], "rebuild rollback failed");
    }
  }

  async sampleActivity(instanceId: string, signal?: AbortSignal): Promise<ContainerActivityMetrics> {
    requireIdentifier(instanceId, "instanceId");
    const requestedName = this.#containerName(instanceId);
    let result: CommandResult;
    try {
      result = await this.#docker(["stats", "--no-stream", "--format", "{{json .}}", requestedName], signal);
    } catch (error) {
      if (!isMissingDockerResourceError(error, "container")) throw error;
      const discovered = await this.#inspectContainer(instanceId, signal);
      const actualName = discovered?.resourceName ?? this.#containerName(instanceId);
      if (!discovered || actualName === requestedName) throw error;
      result = await this.#docker(["stats", "--no-stream", "--format", "{{json .}}", actualName], signal);
    }
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("unexpected docker stats output");
    }
    return parseDockerStats(parsed as DockerStats);
  }

  async diagnose(instanceId: string, signal?: AbortSignal): Promise<ContainerFailureDiagnostics> {
    requireIdentifier(instanceId, "instanceId");
    let names = this.#rebuildArtifactNames(instanceId);
    const candidates: Array<{
      name: string;
      role: ContainerFailureDiagnostics["containerRole"];
      inspected: DockerInspect;
      priority: number;
    }> = [];
    const inspectCandidate = async (
      role: ContainerFailureDiagnostics["containerRole"],
      name: string,
    ): Promise<boolean> => {
      try {
        const inspectResult = await this.#docker(["container", "inspect", name], signal);
        const parsed: unknown = JSON.parse(inspectResult.stdout);
        if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
          throw new Error("unexpected docker inspect output");
        }
        const inspected = parsed[0] as DockerInspect;
        this.#toInstance(inspected, instanceId, name);
        const state = inspected.State;
        const priority =
          state.OOMKilled === true
            ? 100
            : typeof state.ExitCode === "number" && state.ExitCode !== 0
              ? 80
              : state.Health?.Status === "unhealthy"
                ? 60
                : state.Status === "exited" || state.Status === "dead"
                  ? 40
                  : state.Status === "running"
                    ? 20
                    : 0;
        candidates.push({ name, role, inspected, priority });
        return true;
      } catch (error) {
        if (isMissingDockerResourceError(error, "container")) return false;
        throw error;
      }
    };

    // Fast path preserves the existing read contract. Only when the configured
    // canonical name is absent do we resolve a legacy name via ownership labels.
    const canonicalFound = await inspectCandidate("canonical", names.canonical);
    if (!canonicalFound) {
      const discovered = await this.#inspectContainer(instanceId, signal);
      if (discovered) {
        names = this.#rebuildArtifactNames(
          instanceId,
          discovered.resourceName ?? this.#containerName(instanceId),
        );
        await inspectCandidate("canonical", names.canonical);
      }
    }
    for (const [role, name] of [
      ["rollback", names.rollback],
      ["candidate", names.candidate],
      ["previous", names.previous],
    ] as const) {
      await inspectCandidate(role, name);
    }
    const selected = candidates.sort((left, right) => right.priority - left.priority)[0] ?? null;
    if (!selected) throw new Error("container_not_found");
    const { name, role, inspected } = selected;
    const state = inspected.State ?? {};
    const host = inspected.HostConfig ?? {};
    let logTail: string | null = null;
    try {
      const logs = await this.#docker(["logs", "--tail", "100", name], signal);
      const text = `${logs.stdout}\n${logs.stderr}`.trim();
      logTail = text ? text.slice(-16_000) : null;
    } catch {
      // Preserve the inspect result when logs are unavailable (for example a
      // container that was removed between the two read-only calls).
    }
    return {
      containerRole: role,
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      oomKilled: typeof state.OOMKilled === "boolean" ? state.OOMKilled : null,
      health: typeof state.Health?.Status === "string" ? state.Health.Status : null,
      memoryLimit: typeof host.Memory === "number" && host.Memory > 0 ? String(host.Memory) : null,
      memorySwapLimit:
        typeof host.MemorySwap === "number" && host.MemorySwap > 0 ? String(host.MemorySwap) : null,
      cpus: typeof host.NanoCpus === "number" && host.NanoCpus > 0 ? String(host.NanoCpus / 1e9) : null,
      pidsLimit: typeof host.PidsLimit === "number" && host.PidsLimit > 0 ? host.PidsLimit : null,
      logTail,
    };
  }

  async removeEnvironment(request: RemoveContainerEnvironmentRequest): Promise<void> {
    const instanceId = requireIdentifier(request.instanceId, "instanceId");
    const expectedOwnerId = requireIdentifier(request.ownerId, "ownerId");
    const signal = request.signal;
    const storageBinding = this.#workspaceStorageBinding(instanceId, request.storageBindings);
    signal?.throwIfAborted();
    // 先解析 canonical 和所有 rebuild 旁路工件。解析器按标签返回 Docker
    // 实际名称，因此部署前缀变化不会遗漏旧 Environment。
    const artifacts = await this.#inspectRebuildArtifacts(instanceId, signal);
    this.#requireRebuildArtifactOwnership(artifacts, expectedOwnerId);
    const containerEntries = [
      [artifacts.names.canonical, artifacts.canonical],
      [artifacts.names.candidate, artifacts.candidate],
      [artifacts.names.previous, artifacts.previous],
      [artifacts.names.rollback, artifacts.rollbackOccupant],
    ] as const;
    const volume = await this.#inspectManagedResource(
      "volume",
      storageBinding.attachmentRef,
      instanceId,
      expectedOwnerId,
      undefined,
      signal,
      request.storageBindings === undefined ? undefined : storageBinding.storageId,
    );
    const network = await this.#inspectManagedResource(
      "network",
      this.#networkName(instanceId),
      instanceId,
      expectedOwnerId,
      "private",
      signal,
    );
    const egressNetwork = await this.#inspectManagedResource(
      "network",
      this.#egressNetworkName(instanceId),
      instanceId,
      expectedOwnerId,
      "egress",
      signal,
    );

    // 首个破坏性命令前完成全部身份检查；任何 owner 或标签不匹配都会保留
    // 所有 Environment 工件和 Workspace 存储。
    const existingContainers = containerEntries
      .filter((entry): entry is [string, InspectedContainer] => entry[1] !== null)
      .map(([name, container]) => ({ name, container }));
    for (const { name } of existingContainers) {
      await this.#stopContainerArtifact(name, signal);
    }
    if (volume && existingContainers.length > 0) {
      await this.#recoverStateLocks(
        instanceId,
        expectedOwnerId,
        existingContainers.map(({ container }) => container.runtimeId),
        `environment-removal-${this.#randomId()}`,
        undefined,
        storageBinding,
        signal,
        existingContainers
          .map(({ container }) => container.containerHostname)
          .filter((hostname): hostname is string => hostname !== undefined),
      );
    }
    for (const { name } of existingContainers) {
      await this.#removeContainerArtifact(name, signal);
    }
    if (network && this.#config.endpointMode === "network") {
      await this.#disconnectPortal(instanceId, signal, network.Name);
    }
    if (network) await this.#removeManagedResource("network", network.Name, signal);
    if (egressNetwork) await this.#removeManagedResource("network", egressNetwork.Name, signal);
    // 已校验的 Volume 必须保留，只有持久化 Workspace 删除状态机可以释放它。
    void volume;
  }

  async releaseWorkspaceStorage(request: ReleaseContainerStorageRequest): Promise<void> {
    const instanceId = requireIdentifier(request.instanceId, "instanceId");
    const expectedOwnerId = requireIdentifier(request.ownerId, "ownerId");
    const signal = request.signal;
    const storageBinding = this.#workspaceStorageBinding(instanceId, request.storageBindings);
    signal?.throwIfAborted();
    const volume = await this.#inspectManagedResource(
      "volume",
      storageBinding.attachmentRef,
      instanceId,
      expectedOwnerId,
      undefined,
      signal,
      request.storageBindings === undefined ? undefined : storageBinding.storageId,
    );
    if (volume) await this.#removeManagedResource("volume", volume.Name, signal);
  }

  async remove(instanceId: string, ownerId: string, signal?: AbortSignal): Promise<void> {
    await this.removeEnvironment({ instanceId, ownerId, ...(signal ? { signal } : {}) });
    await this.releaseWorkspaceStorage({ instanceId, ownerId, ...(signal ? { signal } : {}) });
  }

  async listImages() {
    const result = await this.#docker([
      "images",
      "--digests",
      "--no-trunc",
      "--filter",
      "dangling=false",
      "--format",
      "{{.Repository}} {{.Tag}} {{.Digest}} {{.ID}} {{.Size}}",
    ]);
    const images: Array<{ reference: string; id?: string; size?: string }> = [];
    const seen = new Set<string>();
    for (const rawLine of result.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const [repository, tag, digest, id, ...size] = line.split(/\s+/u);
      if (!repository || repository === "<none>") continue;
      const references = [
        tag && tag !== "<none>" ? `${repository}:${tag}` : null,
        /^sha256:[a-f0-9]{64}$/iu.test(digest ?? "") ? `${repository}@${digest}` : null,
      ].filter((reference): reference is string => Boolean(reference));
      for (const reference of references) {
        if (seen.has(reference)) continue;
        seen.add(reference);
        images.push({
          reference,
          ...(id && id !== "<none>" ? { id } : {}),
          ...(size.length ? { size: size.join(" ") } : {}),
        });
      }
    }
    return images;
  }

  async resolveImage(reference: string): Promise<string | null> {
    if (!IMAGE_PATTERN.test(reference)) throw new Error("image reference is invalid");
    try {
      const result = await this.#docker(["image", "inspect", "--format", "{{.Id}}", reference]);
      const imageId = result.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/iu.test(imageId)) {
        throw new Error("runtime returned an invalid immutable image id");
      }
      return imageId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No such image|not found/i.test(message)) return null;
      throw error;
    }
  }

  async validateImage(reference: string, runtimeContract: string): Promise<void> {
    if (runtimeContract === NO_RUNTIME_CONTRACT) return;
    if (runtimeContract !== this.#profile().contract && runtimeContract !== GENERIC_RUNTIME_CONTRACT) {
      throw new ContainerArtifactValidationError("runtime_image_contract_unsupported", "unsupported");
    }
    const result = await this.#docker(["image", "inspect", "--format", "{{json .Config}}", reference]);
    const config = JSON.parse(result.stdout.trim()) as {
      Entrypoint?: unknown;
      Cmd?: unknown;
      User?: unknown;
      ExposedPorts?: Record<string, unknown>;
    };
    const entrypoint = config.Entrypoint;
    const command = config.Cmd;
    const expectedCommand = [...this.#profile().command];
    const exactEntrypoint =
      Array.isArray(entrypoint) && entrypoint.length === 1 && entrypoint[0] === this.#profile().entrypoint;
    const exactCommand =
      Array.isArray(command) &&
      command.length === expectedCommand.length &&
      command.every((part, index) => part === expectedCommand[index]);
    if (
      !exactEntrypoint ||
      !exactCommand ||
      config.User !== this.#profile().containerUser ||
      !config.ExposedPorts?.[this.#portKey()]
    ) {
      throw new ContainerArtifactValidationError("runtime_image_contract_invalid", "invalid");
    }
  }

  async validateBuiltImage(reference: string, runtimeContract: string): Promise<void> {
    if (runtimeContract === NO_RUNTIME_CONTRACT) return;
    if (runtimeContract !== this.#profile().contract && runtimeContract !== GENERIC_RUNTIME_CONTRACT) {
      throw new ContainerArtifactValidationError("runtime_image_contract_unsupported", "unsupported");
    }
    await this.validateImage(reference, runtimeContract);
    const platform = (
      await this.#docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", reference])
    ).stdout.trim();
    if (platform !== this.#config.targetPlatform) {
      throw new ContainerArtifactValidationError("runtime_image_platform_invalid", "invalid");
    }

    const suffix = this.#randomId()
      .replace(/[^A-Za-z0-9_.-]/gu, "")
      .slice(0, 64);
    if (!suffix) throw new Error("runtime_image_smoke_name_invalid");
    const containerName = `openapp-image-smoke-${suffix}`;
    let containerCreated = false;
    const mcpEnvironmentKey = this.#profile().providerEnvironment?.mcpAppSandboxOriginKey;
    await withRuntimeCleanup(
      async () => {
        await this.#docker([
          "run",
          "--detach",
          "--name",
          containerName,
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges=true",
          "--restart",
          "no",
          // 与正式命名 Volume 一样复制镜像目录及属主；不假定应用 UID 或解释器。
          // 烟测独占匿名 Volume，由 finally 中的 rm --volumes 回收。
          "--mount",
          `type=volume,destination=${this.#profile().storageMountPath}`,
          ...Object.entries(this.#config.runtimeEnvironment ?? {}).flatMap(([key, value]) => [
            "--env",
            `${key}=${value}`,
          ]),
          ...(this.#config.mcpAppSandboxOrigin &&
          mcpEnvironmentKey &&
          !Object.hasOwn(this.#config.runtimeEnvironment ?? {}, mcpEnvironmentKey)
            ? ["--env", `${mcpEnvironmentKey}=${this.#config.mcpAppSandboxOrigin}`]
            : []),
          reference,
        ]);
        containerCreated = true;
        await this.#probeContainerHealth(containerName);
      },
      async () => {
        if (containerCreated) {
          let cleanupError: unknown;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              await this.#docker(["rm", "--force", "--volumes", containerName]);
              cleanupError = undefined;
              break;
            } catch (error) {
              cleanupError = error;
            }
          }
          if (cleanupError) throw new Error("runtime_image_smoke_cleanup_failed", { cause: cleanupError });
        }
      },
    );
  }

  async removeImageIfCurrent(reference: string, expectedImageId: string): Promise<boolean> {
    if (!IMAGE_PATTERN.test(reference)) throw new Error("image reference is invalid");
    if (!/^sha256:[a-f0-9]{64}$/iu.test(expectedImageId)) {
      throw new Error("expected image id is invalid");
    }
    let current: string | null;
    try {
      current = await this.resolveImage(reference);
    } catch {
      return false;
    }
    if (current !== expectedImageId) return false;
    try {
      // Build tag 只属于一个持久化构建；不可变 ID 守卫确保删除该 tag 时不会
      // 误触碰同一镜像的其他别名。
      await this.#docker(["image", "rm", reference]);
      return true;
    } catch {
      return false;
    }
  }

  async pullImage(reference: string) {
    await this.#docker(["pull", reference]);
  }

  async loadImage(archivePath: string, reference: string) {
    const result = await this.#docker(["load", "--input", archivePath]);
    const loadedReferences = [
      ...new Set(
        `${result.stdout}\n${result.stderr}`
          .split("\n")
          .map((line) => line.match(/^Loaded image(?: ID)?:\s*(.+)$/u)?.[1]?.trim())
          .filter((value): value is string => Boolean(value)),
      ),
    ];
    if (loadedReferences.length !== 1) {
      throw new Error("image archive must contain exactly one tagged image");
    }
    if (reference.includes("@sha256:") && loadedReferences[0] !== reference) {
      // `load` 后可以创建 Docker 镜像 tag，但 digest 按内容寻址，不能通过
      // `docker tag` 伪造。
      throw new Error("image archive does not contain the requested digest");
    }
    if (loadedReferences[0] !== reference) {
      await this.#docker(["tag", loadedReferences[0]!, reference]);
    }
  }
  async status() {
    const runtime = this.#config.runtime ?? "docker";
    try {
      const result = await this.#docker([
        "version",
        "--format",
        "{{.Server.Version}}|{{.Server.Os}}|{{.Server.Arch}}",
      ]);
      const [version, platform, architecture] = result.stdout.trim().split("|");
      return version
        ? {
            runtime,
            available: true,
            version,
            ...(platform ? { platform } : {}),
            ...(architecture ? { architecture } : {}),
          }
        : { runtime, available: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /permission denied/iu.test(message)
        ? "docker_socket_permission_denied"
        : /Cannot connect|connection refused|Is the docker daemon running/iu.test(message)
          ? "docker_daemon_unavailable"
          : "docker_api_unavailable";
      return { runtime, available: false, error: code };
    }
  }

  #containerName(instanceId: string): string {
    return (
      this.#resolvedResourceRefs.get(
        this.#resourceCacheKey("container", instanceId, undefined, undefined, "canonical"),
      )?.name ?? `${this.#config.namePrefix}${instanceId}`
    );
  }

  #resourceCacheKey(
    kind: ManagedResourceKind,
    instanceId: string,
    networkRole?: ManagedNetworkRole,
    storageId?: string,
    containerRole = "canonical",
  ): string {
    return [kind, instanceId, networkRole ?? "", storageId ?? "", containerRole].join("|");
  }

  #volumeName(instanceId: string): string {
    return (
      this.#resolvedResourceRefs.get(
        this.#resourceCacheKey("volume", instanceId, undefined, `workspace-storage:${instanceId}`),
      )?.name ?? `${this.#config.volumePrefix}${instanceId}`
    );
  }

  #workspaceStorageBinding(
    instanceId: string,
    bindings: readonly StorageBinding[] | undefined,
  ): StorageBinding {
    const binding =
      bindings === undefined
        ? {
            storageId: `workspace-storage:${instanceId}`,
            attachmentRef: this.#volumeName(instanceId),
            mountPath: this.#profile().storageMountPath,
            readOnly: false,
          }
        : bindings.length === 1
          ? bindings[0]
          : undefined;
    if (!binding) throw new Error("exactly one workspace storage binding is required");
    if (binding.storageId !== `workspace-storage:${instanceId}`) {
      throw new Error("workspace storage identity mismatch");
    }
    if (!IDENTIFIER_PATTERN.test(binding.attachmentRef)) {
      throw new Error("workspace storage attachment is unsafe");
    }
    if (binding.mountPath !== this.#profile().storageMountPath || binding.readOnly) {
      throw new Error("workspace storage mount contract mismatch");
    }
    return { ...binding };
  }

  #networkName(instanceId: string): string {
    return (
      this.#resolvedResourceRefs.get(this.#resourceCacheKey("network", instanceId, "private"))?.name ??
      `${this.#config.networkPrefix}${instanceId}`
    );
  }

  #egressNetworkName(instanceId: string): string {
    return (
      this.#resolvedResourceRefs.get(this.#resourceCacheKey("network", instanceId, "egress"))?.name ??
      `${this.#config.networkPrefix}${instanceId}-egress`
    );
  }

  #launchProfile(request: ProvisionContainerRequest) {
    const profile = request.launchProfile ?? {
      imageReference: this.#config.image,
      resources: {
        memory: this.#config.memory,
        cpus: this.#config.cpus,
        pidsLimit: this.#config.pidsLimit,
      },
      environment: {},
      configFiles: [],
    };
    if (!IMAGE_PATTERN.test(profile.imageReference)) throw new Error("launch profile image is invalid");
    if (!validMemory(profile.resources.memory)) throw new Error("launch profile memory is invalid");
    const cpus = Number(profile.resources.cpus);
    if (!Number.isFinite(cpus) || cpus <= 0 || cpus > 256) throw new Error("launch profile cpus is invalid");
    if (
      !Number.isSafeInteger(profile.resources.pidsLimit) ||
      profile.resources.pidsLimit < 32 ||
      profile.resources.pidsLimit > 1_048_576
    ) {
      throw new Error("launch profile pidsLimit is invalid");
    }
    const environmentEntries = Object.entries(profile.environment);
    if (environmentEntries.length > ENVIRONMENT_MAX_ENTRIES)
      throw new Error("launch profile environment is too large");
    let environmentBytes = 0;
    for (const [key, value] of environmentEntries) {
      if (
        !ENVIRONMENT_NAME_PATTERN.test(key) ||
        isRuntimeReservedEnvironmentName(key, {
          additionalReserved: runtimeReservedEnvironmentNames(this.#profile()),
        })
      ) {
        throw new Error(`launch profile environment key is not allowed: ${key}`);
      }
      if (typeof value !== "string" || ENVIRONMENT_CONTROL_PATTERN.test(value)) {
        throw new Error(`launch profile environment value is invalid: ${key}`);
      }
      const valueBytes = Buffer.byteLength(value);
      if (valueBytes > ENVIRONMENT_VALUE_MAX_BYTES) {
        throw new Error("launch profile environment is too large");
      }
      environmentBytes += Buffer.byteLength(key) + valueBytes;
    }
    if (environmentBytes > ENVIRONMENT_MAX_BYTES) throw new Error("launch profile environment is too large");
    const configPaths = new Set<string>();
    let configBytes = 0;
    if (profile.configFiles.length > 128) throw new Error("launch profile config files are too large");
    for (const file of profile.configFiles) {
      if (
        !CONFIG_PATH_PATTERN.test(file.path) ||
        file.path.endsWith("/") ||
        file.path.split("/").some((part) => !part)
      ) {
        throw new Error(`launch profile config path is unsafe: ${file.path}`);
      }
      if (typeof file.content !== "string" || file.content.includes("\0")) {
        throw new Error(`launch profile config content is invalid: ${file.path}`);
      }
      if (configPaths.has(file.path))
        throw new Error(`launch profile config path is duplicated: ${file.path}`);
      configPaths.add(file.path);
      configBytes += Buffer.byteLength(file.path) + Buffer.byteLength(file.content);
    }
    if (configBytes > CONFIG_FILES_MAX_BYTES) throw new Error("launch profile config files are too large");
    return profile;
  }

  #docker(args: readonly string[], signal?: AbortSignal): Promise<CommandResult> {
    signal?.throwIfAborted();
    const contextArgs = this.#config.dockerContext
      ? ["--context", this.#config.dockerContext, ...args]
      : args;
    const command = args[0];
    const timeoutMs =
      command === "pull" || command === "load"
        ? RUNTIME_LONG_COMMAND_TIMEOUT_MS
        : command === "stats" || command === "version"
          ? RUNTIME_PROBE_TIMEOUT_MS
          : command === "stop"
            ? RUNTIME_STOP_TIMEOUT_MS
            : RUNTIME_COMMAND_TIMEOUT_MS;
    return this.#run(this.#config.binary, contextArgs, { timeoutMs, ...(signal ? { signal } : {}) });
  }

  async #ensureManagedVolume(
    name: string,
    instanceId: string,
    ownerId: string,
    storageId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const allowLegacyStorageRef = name === this.#volumeName(instanceId);
    const existing = await this.#inspectManagedResource(
      "volume",
      name,
      instanceId,
      ownerId,
      undefined,
      signal,
      storageId,
      allowLegacyStorageRef,
    );
    if (existing) return existing.Name;
    try {
      await this.#docker(
        ["volume", "create", ...this.#volumeLabelArgs(instanceId, ownerId, storageId), name],
        signal,
      );
    } catch {
      // 并发 provision 可能已经创建了同名资源；经过完整或受限 legacy 身份校验的
      // inspect 结果才是权威状态。
      const concurrent = await this.#inspectManagedResource(
        "volume",
        name,
        instanceId,
        ownerId,
        undefined,
        signal,
        storageId,
        allowLegacyStorageRef,
      );
      if (concurrent) return concurrent.Name;
      throw new Error("volume creation failed without a managed resource");
    }
    return name;
  }

  async #ensureManagedNetwork(
    name: string,
    instanceId: string,
    ownerId: string,
    createOptions: readonly string[],
    networkPolicy: NetworkPolicy,
    signal?: AbortSignal,
  ): Promise<string> {
    const existing = await this.#inspectManagedResource(
      "network",
      name,
      instanceId,
      ownerId,
      networkPolicy,
      signal,
    );
    if (existing) return existing.Name;
    const startIndex = stableHash(`${instanceId}:${networkPolicy}`) % this.#networkPool.subnetCount;
    const probeStep =
      ((stableHash(`${instanceId}:${networkPolicy}:probe`) | 1) >>> 0) % this.#networkPool.subnetCount || 1;
    const attempts = this.#networkPool.subnetCount;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const subnetIndex = (startIndex + attempt * probeStep) % this.#networkPool.subnetCount;
      const subnet = `${formatIpv4Address(this.#networkPool.baseAddress + subnetIndex * this.#networkPool.subnetSize)}/${this.#networkPool.subnetPrefix}`;
      try {
        await this.#docker(
          [
            "network",
            "create",
            ...createOptions,
            "--subnet",
            subnet,
            "--label",
            `${this.#labelPrefix()}.network-pool=${this.#networkPool.cidr}`,
            "--label",
            `${this.#labelPrefix()}.network-subnet=${subnet}`,
            ...this.#labelArgs(instanceId, ownerId, networkPolicy),
            name,
          ],
          signal,
        );
        return name;
      } catch (error) {
        const concurrent = await this.#inspectManagedResource(
          "network",
          name,
          instanceId,
          ownerId,
          networkPolicy,
          signal,
        );
        if (concurrent) return concurrent.Name;
        const message = error instanceof Error ? error.message : String(error);
        if (
          !/pool overlaps|address pool.*(?:overlap|exhaust)|could not find an available.*address pool/iu.test(
            message,
          )
        )
          throw error;
      }
    }
    throw new Error(`managed network address pool exhausted after ${attempts} probes`);
  }

  async #inspectManagedResource(
    kind: "network" | "volume",
    name: string,
    instanceId: string,
    ownerId: string,
    networkPolicy?: NetworkPolicy,
    signal?: AbortSignal,
    storageId?: string,
    allowMissingStorageRef = false,
  ): Promise<DockerManagedResourceInspect | null> {
    const aliasNames = this.#resourceAliasNames(kind, instanceId, name, storageId);
    const identity: ManagedResourceIdentity = {
      instanceId,
      ownerId,
      ...(networkPolicy ? { networkRole: networkPolicy } : {}),
      ...(storageId ? { storageId } : {}),
      ...(allowMissingStorageRef ? { allowLegacyStorageRef: true } : {}),
      ...(allowMissingStorageRef ? { legacyStorageNames: [name, ...aliasNames] } : {}),
      labelPrefixes: this.#labelPrefixes(),
    };
    const exact = await this.#inspectManagedResourceByName(kind, name, signal);
    if (exact) return this.#selectAndRememberResource(exact, identity, kind, networkPolicy, storageId);

    // 配置切换后先尝试显式 legacy 前缀，避免在老 Docker API 上依赖 label list。
    const candidates: DockerManagedResourceInspect[] = [];
    for (const aliasName of aliasNames) {
      const candidate = await this.#inspectManagedResourceByName(kind, aliasName, signal);
      if (candidate) candidates.push(candidate);
    }

    // 任意自定义前缀无法通过配置枚举时，再按完整 managed labels 发现资源。
    if (candidates.length === 0 && this.#config.resourceDiscovery !== false) {
      const discoveredNames = await this.#listManagedResourceNames(kind, instanceId, signal);
      for (const discoveredName of discoveredNames) {
        if (discoveredName === name || aliasNames.includes(discoveredName)) continue;
        const candidate = await this.#inspectManagedResourceByName(kind, discoveredName, signal);
        if (candidate && networkPolicy && this.#discoveredNetworkHasOtherRole(candidate, networkPolicy))
          continue;
        if (candidate) candidates.push(candidate);
      }
    }
    if (candidates.length === 0) return null;
    return this.#selectAndRememberResource(candidates, identity, kind, networkPolicy, storageId);
  }

  #discoveredNetworkHasOtherRole(
    candidate: DockerManagedResourceInspect,
    expectedRole: NetworkPolicy,
  ): boolean {
    if (candidate.Name === "") return false;
    const role = inferManagedNetworkRole(
      {
        kind: "network",
        name: candidate.Name,
        ...(candidate.Labels ? { labels: candidate.Labels } : {}),
        ...(candidate.Internal === undefined ? {} : { internal: candidate.Internal }),
        ...(candidate.Options ? { options: candidate.Options } : {}),
      },
      this.#labelPrefixes(),
    );
    return role !== undefined && role !== expectedRole;
  }

  async #inspectManagedResourceByName(
    kind: ManagedResourceKind,
    name: string,
    signal?: AbortSignal,
  ): Promise<DockerManagedResourceInspect | null> {
    let result: CommandResult;
    try {
      result = await this.#docker([kind, "inspect", name], signal);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (new RegExp(`No such ${kind}|not found`, "i").test(message)) return null;
      throw error;
    }
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0] || typeof parsed[0] !== "object") {
      throw new Error(`unexpected docker ${kind} inspect output`);
    }
    const resource = parsed[0] as DockerManagedResourceInspect;
    if (resource.Name !== name) throw new Error(`unexpected docker ${kind} inspect resource name`);
    return resource;
  }

  #selectAndRememberResource(
    resource: DockerManagedResourceInspect | readonly DockerManagedResourceInspect[],
    identity: ManagedResourceIdentity,
    kind: ManagedResourceKind,
    networkPolicy?: NetworkPolicy,
    storageId?: string,
  ): DockerManagedResourceInspect {
    const values = Array.isArray(resource) ? resource : [resource];
    const selected = selectManagedResource(
      values.map((candidate) => ({
        kind,
        name: candidate.Name,
        ...(candidate.Id ? { id: candidate.Id } : {}),
        ...(candidate.Labels ? { labels: candidate.Labels } : {}),
        ...(candidate.Internal === undefined ? {} : { internal: candidate.Internal }),
        ...(candidate.Options ? { options: candidate.Options } : {}),
      })),
      identity,
      kind,
    );
    if (networkPolicy) {
      // 旧资源可能没有 role label，selector 已通过 Docker 隔离属性完成推断；
      // 这里保留一次显式检查，防止未来 selector 被其他资源类型复用时放宽。
      if (networkPolicy === "private" && selected.internal !== true) {
        throw new ManagedResourceResolutionError("resource_identity_mismatch", identity, kind, [
          selected.name,
        ]);
      }
      if (
        networkPolicy === "egress" &&
        (selected.internal === true || selected.options?.["com.docker.network.bridge.enable_icc"] !== "false")
      ) {
        throw new ManagedResourceResolutionError("resource_identity_mismatch", identity, kind, [
          selected.name,
        ]);
      }
    }
    const original = values.find((candidate) => candidate.Name === selected.name)!;
    const enriched: DockerManagedResourceInspect = {
      ...original,
      scheme: selected.scheme,
      legacy: selected.legacy,
      migrationRequired: selected.migrationRequired,
    };
    this.#resolvedResourceRefs.set(
      this.#resourceCacheKey(kind, identity.instanceId, networkPolicy, storageId),
      selected,
    );
    return enriched;
  }

  #resourceAliasNames(
    kind: "network" | "volume",
    instanceId: string,
    requestedName: string,
    storageId?: string,
  ): string[] {
    const prefixes =
      kind === "network"
        ? (this.#config.legacyNetworkPrefixes ?? [])
        : (this.#config.legacyVolumePrefixes ?? []);
    const names = new Set<string>();
    if (kind === "volume" && storageId !== undefined) {
      // StorageBinding 可能直接携带数据库中保存的旧 attachmentRef。
      names.add(requestedName);
    }
    for (const prefix of prefixes) {
      names.add(
        `${prefix}${instanceId}${kind === "network" && requestedName.endsWith("-egress") ? "-egress" : ""}`,
      );
    }
    names.delete(requestedName);
    return [...names];
  }

  async #listManagedResourceNames(
    kind: ManagedResourceKind,
    instanceId: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const names = new Set<string>();
    for (const labelPrefix of this.#labelPrefixes()) {
      const label = `${labelPrefix}.instance-id`;
      const args =
        kind === "container"
          ? ["ps", "-a", "--filter", `label=${label}=${instanceId}`, "--format", "{{.Names}}"]
          : [kind, "ls", "--filter", `label=${label}=${instanceId}`, "--format", "{{.Name}}"];
      try {
        const result = await this.#docker(args, signal);
        for (const name of parseResourceNameList(result.stdout)) names.add(name);
      } catch (error) {
        // 自定义 CommandRunner（如契约测试）可能不实现 ls；生产 runner 会保留
        // DockerCommandError，让真实 daemon 故障继续向上报告。明确的旧 CLI
        // “未知命令”才降级为空候选，随后仍可按确定名称创建/使用资源。
        if (isUnsupportedResourceDiscoveryError(error)) continue;
        if (error instanceof Error && error.name !== "DockerCommandError") continue;
        throw error;
      }
      if (names.size > 0) break;
    }
    return [...names];
  }

  #labelArgs(instanceId: string, ownerId: string, role?: ManagedNetworkRole): string[] {
    return resourceLabelArgs(
      { instanceId, ownerId },
      this.#config.resourceScheme ?? DEFAULT_RESOURCE_SCHEME,
      role,
      this.#labelPrefixes(),
    );
  }

  #volumeLabelArgs(instanceId: string, ownerId: string, storageId: string): string[] {
    return [...this.#labelArgs(instanceId, ownerId), ...this.#storageLabelArgs(storageId)];
  }

  #storageLabelArgs(storageId: string): string[] {
    return this.#labelPrefixes().flatMap((prefix) => ["--label", `${prefix}.storage-ref=${storageId}`]);
  }

  #containerLabelArgs(
    instanceId: string,
    ownerId: string,
    request: ProvisionContainerRequest,
    rebuild?: RebuildContainerMetadata,
  ): string[] {
    const labels = this.#labelArgs(instanceId, ownerId);
    if (request.appId) labels.push("--label", `${this.#labelPrefix()}.app-id=${requireAppId(request.appId)}`);
    if (request.appVersionId)
      labels.push(
        "--label",
        `${this.#labelPrefix()}.app-version-id=${requireIdentifier(request.appVersionId, "appVersionId")}`,
      );
    if (request.imageArtifactId) {
      labels.push(
        "--label",
        `${this.#labelPrefix()}.image-artifact-id=${requireIdentifier(request.imageArtifactId, "imageArtifactId")}`,
      );
    }
    if (request.imageReference) {
      if (!IMAGE_PATTERN.test(request.imageReference)) throw new Error("image reference label is invalid");
      labels.push("--label", `${this.#labelPrefix()}.image-reference=${request.imageReference}`);
    }
    if (request.appId && request.imageReference) {
      labels.push("--label", `${this.#labelPrefix()}.catalog-snapshot=true`);
    }
    if (rebuild) {
      labels.push("--label", `${this.#labelPrefix()}.rebuild-id=${rebuild.id}`);
      labels.push("--label", `${this.#labelPrefix()}.rebuild-predecessor-id=${rebuild.predecessorId}`);
      labels.push("--label", `${this.#labelPrefix()}.rebuild-role=candidate`);
      labels.push("--label", `${this.#labelPrefix()}.rebuild-start-requested=${rebuild.startRequested}`);
      if (rebuild.sourceCatalogSnapshot) {
        labels.push(
          ...catalogSnapshotLabelArgs(rebuild.sourceCatalogSnapshot, "rebuild-source-", this.#labelPrefix()),
        );
      }
    }
    return labels;
  }

  async #probeContainerHealth(name: string, signal?: AbortSignal): Promise<void> {
    const probeName = `openapp-health-probe-${randomUUID()}`;
    await withRuntimeCleanup(
      async () => {
        await this.#docker(
          [
            "run",
            "--rm",
            "--name",
            probeName,
            "--network",
            `container:${name}`,
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--pids-limit",
            "64",
            "--memory",
            "128m",
            "--entrypoint",
            "node",
            this.#config.probeImage ?? "node:24-bookworm-slim",
            "-e",
            IMAGE_SMOKE_HEALTH_PROBE(this.#profile().containerPort, this.#profile().healthPath),
          ],
          signal,
        );
      },
      async () => {
        // CLI 被取消时容器可能仍在运行，清理不继承取消信号；只处理本次唯一探针。
        try {
          await this.#docker(["rm", "--force", probeName]);
        } catch (error) {
          if (!(error instanceof Error && /No such container/i.test(error.message))) throw error;
        }
      },
    );
  }

  async #removeRebuildPredecessor(
    instanceId: string,
    ownerId: string,
    expectedCandidateId: string | null,
    expectedRebuild: RebuildContainerMetadata,
    signal?: AbortSignal,
  ): Promise<void> {
    const names = this.#rebuildArtifactNames(instanceId);
    try {
      await this.#docker(["rm", "--force", names.previous], signal);
      return;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!expectedCandidateId) throw error;

      let committed = false;
      try {
        const artifacts = await this.#inspectRebuildArtifacts(instanceId, signal);
        const rollbackOccupant =
          artifacts.rollback ?? (await this.#inspectContainerByName(names.rollback, instanceId, signal));
        const canonicalRebuild = artifacts.canonical?.rebuild;
        committed =
          artifacts.canonical?.runtimeId === expectedCandidateId &&
          artifacts.canonical.ownerId === ownerId &&
          canonicalRebuild?.id === expectedRebuild.id &&
          canonicalRebuild.predecessorId === expectedRebuild.predecessorId &&
          canonicalRebuild.startRequested === expectedRebuild.startRequested &&
          !artifacts.candidate &&
          !artifacts.previous &&
          !rollbackOccupant;
      } catch {
        if (signal?.aborted) throw signal.reason;
      }
      if (signal?.aborted) throw signal.reason;
      if (!committed) throw error;
    }
  }

  async #recoverStateLocks(
    instanceId: string,
    ownerId: string,
    authorizedContainerIds: readonly string[],
    recoveryId: string,
    recoveryImageReference: string | undefined,
    storageBinding: StorageBinding,
    signal?: AbortSignal,
    authorizedContainerHosts: readonly string[] = [],
  ): Promise<void> {
    const ids = [...new Set(authorizedContainerIds.map(requireDockerContainerId))];
    const recoveryCommand = this.#profile().recoveryCommand;
    // 没有应用恢复能力时仅执行通用容器生命周期，不假设镜像包含某种解释器。
    if (!recoveryCommand) return;
    const hostnames = normalizeDockerContainerHostnames(authorizedContainerHosts);
    if (ids.length === 0 && hostnames.length === 0) return;
    requireIdentifier(recoveryId, "rebuildId");
    const volume = await this.#inspectManagedResource(
      "volume",
      storageBinding.attachmentRef,
      instanceId,
      ownerId,
      undefined,
      signal,
      storageBinding.storageId,
      this.#allowsLegacyStorageRef(instanceId, storageBinding),
    );
    if (!volume) {
      throw new ManagedResourceResolutionError(
        "provider_resource_missing",
        {
          instanceId,
          ownerId,
          storageId: storageBinding.storageId,
          ...(this.#allowsLegacyStorageRef(instanceId, storageBinding)
            ? { allowLegacyStorageRef: true }
            : {}),
        },
        "volume",
        [storageBinding.attachmentRef],
      );
    }
    await this.#docker(
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges=true",
        "--pids-limit",
        "64",
        "--memory",
        "128m",
        ...this.#labelArgs(instanceId, ownerId),
        "--mount",
        `type=volume,source=${volume.Name},target=${storageBinding.mountPath}`,
        "--env",
        `${this.#envName("containers")}=${ids.join(",")}`,
        ...(hostnames.length > 0 ? ["--env", `${this.#envName("hosts")}=${hostnames.join(",")}`] : []),
        "--env",
        `${this.#envName("recoveryId")}=${recoveryId}`,
        "--entrypoint",
        recoveryCommand[0]!,
        recoveryImageReference ?? this.#config.image,
        ...recoveryCommand.slice(1),
      ],
      signal,
    );
  }

  async #fenceFailedCandidate(
    instanceId: string,
    ownerId: string,
    name: string,
    rollbackName: string,
    runtimeId: string,
    recoveryId: string,
    storageBinding: StorageBinding,
    signal?: AbortSignal,
  ): Promise<void> {
    // candidate 的容器 ID 是反向 fencing 的唯一授权依据。专用 tombstone
    // 保留事务标签，直到 previous 已按原意图恢复；任一中间崩溃都可重放。
    const candidate = await this.#inspectContainerByName(name, instanceId, signal);
    if (!candidate || candidate.ownerId !== ownerId || candidate.runtimeId !== runtimeId) {
      throw new Error("managed rebuild candidate changed before rollback fencing");
    }
    await this.#docker(["stop", "--time", "30", name], signal);
    if (name !== rollbackName) await this.#docker(["rename", name, rollbackName], signal);
    await this.#recoverStateLocks(
      instanceId,
      ownerId,
      [runtimeId],
      recoveryId,
      candidate.catalogSnapshot?.imageReference,
      storageBinding,
      signal,
      candidate.containerHostname ? [candidate.containerHostname] : [],
    );
  }

  #requireManagedLabels(
    labels: Record<string, string> | undefined,
    instanceId: string,
    ownerId: string | undefined,
    kind: ManagedResourceKind,
    storageId?: string,
    allowMissingStorageRef = false,
  ): string {
    const managed = resourceLabel(labels, "managed", this.#labelPrefixes());
    const actualInstance = resourceLabel(labels, "instance-id", this.#labelPrefixes());
    const actualOwner = resourceLabel(labels, "owner-id", this.#labelPrefixes());
    const actualStorageRef = resourceLabel(labels, "storage-ref", this.#labelPrefixes());
    const storageRefMismatch =
      storageId !== undefined &&
      actualStorageRef !== storageId &&
      !(allowMissingStorageRef && actualStorageRef === undefined);
    if (
      managed !== "true" ||
      actualInstance !== instanceId ||
      !actualOwner ||
      (ownerId !== undefined && actualOwner !== ownerId) ||
      storageRefMismatch
    ) {
      throw new ManagedResourceResolutionError(
        "resource_identity_mismatch",
        {
          instanceId,
          ownerId: ownerId ?? actualOwner ?? "unknown-owner",
          ...(storageId ? { storageId } : {}),
          ...(allowMissingStorageRef ? { allowLegacyStorageRef: true } : {}),
        },
        kind === "container" ? "container" : kind,
      );
    }
    requireIdentifier(actualOwner, `${kind} ownerId`);
    return actualOwner;
  }

  #allowsLegacyStorageRef(instanceId: string, binding: StorageBinding): boolean {
    if (binding.attachmentRef === `${this.#config.volumePrefix}${instanceId}`) return true;
    return (this.#config.legacyVolumePrefixes ?? []).some(
      (prefix) => binding.attachmentRef === `${prefix}${instanceId}`,
    );
  }

  async #require(
    instanceId: string,
    signal?: AbortSignal,
    storageBindings?: readonly StorageBinding[],
  ): Promise<ContainerInstance> {
    const instance = await this.#get(instanceId, signal, storageBindings);
    if (!instance) throw new Error(`container ${instanceId} disappeared during the operation`);
    return instance;
  }

  async #inspectContainer(instanceId: string, signal?: AbortSignal): Promise<InspectedContainer | null> {
    const requestedName = this.#containerName(instanceId);
    // 当前配置名称是稳定路径：命中后立即返回，避免普通读请求扫描旧别名。
    // 只有名称不存在时才进入兼容发现；这也让旧 Docker wrapper 不必实现
    // `ps --filter label`，并避免把同一 inspect 响应误判为多个资源。
    const current = await this.#inspectContainerByName(requestedName, instanceId, signal);
    if (current) {
      this.#rememberContainerName(instanceId, requestedName);
      return current;
    }

    const names = new Set<string>();
    for (const prefix of this.#config.legacyNamePrefixes ?? []) {
      names.add(`${prefix}${instanceId}`);
    }
    let found: InspectedContainer | null = null;
    let foundName: string | null = null;
    for (const name of names) {
      if (name === requestedName) continue;
      const instance = await this.#inspectContainerByName(name, instanceId, signal);
      if (instance) {
        if (found) {
          throw new ManagedResourceResolutionError(
            "resource_identity_ambiguous",
            { instanceId, ownerId: found.ownerId },
            "container",
            [foundName ?? requestedName, name],
          );
        }
        found = instance;
        foundName = name;
      }
    }
    if (this.#config.resourceDiscovery !== false) {
      const discovered = await this.#listManagedResourceNames("container", instanceId, signal);
      for (const name of discovered) {
        // 列表按 instance-id 标签返回时也会包含 rebuild 旁路工件；它们
        // 不能被误记为 canonical，否则后续 stop/remove 会操作错误代次。
        if (names.has(name) || name === foundName || isRebuildArtifactName(name)) continue;
        const instance = await this.#inspectContainerByName(name, instanceId, signal);
        if (instance) {
          if (found) {
            throw new ManagedResourceResolutionError(
              "resource_identity_ambiguous",
              { instanceId, ownerId: found.ownerId },
              "container",
              [foundName ?? requestedName, name],
            );
          }
          found = instance;
          foundName = name;
        }
      }
    }
    if (found && foundName) {
      this.#rememberContainerName(instanceId, foundName);
      return found;
    }
    this.#forgetResourceRef("container", requestedName);
    return null;
  }

  async #inspectContainerByName(
    name: string,
    expectedInstanceId: string,
    signal?: AbortSignal,
  ): Promise<InspectedContainer | null> {
    try {
      const result = await this.#docker(["container", "inspect", name], signal);
      const parsed: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("unexpected docker inspect output");
      return this.#toInstance(parsed[0] as DockerInspect, expectedInstanceId, name);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (/No such (object|container|inspect)|not found/i.test(message)) return null;
      throw error;
    }
  }

  #rememberContainerName(instanceId: string, name: string): void {
    const current = this.#resolvedResourceRefs.get(
      this.#resourceCacheKey("container", instanceId, undefined, undefined, "canonical"),
    );
    if (current?.name === name) return;
    this.#resolvedResourceRefs.set(
      this.#resourceCacheKey("container", instanceId, undefined, undefined, "canonical"),
      {
        kind: "container",
        name,
        scheme: "legacy",
        legacy: name !== `${this.#config.namePrefix}${instanceId}`,
        migrationRequired: false,
      },
    );
  }

  async #removeContainerArtifact(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#docker(["rm", "--force", name], signal);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (!/No such (object|container)|not found/iu.test(message)) throw error;
    }
    this.#forgetResourceRef("container", name);
  }

  async #stopContainerArtifact(name: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#docker(["stop", "--time", "30", name], signal);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (!/No such (object|container)|not found|is not running/iu.test(message)) throw error;
    }
  }

  async #removeManagedResource(
    kind: "network" | "volume",
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.#docker([kind, "rm", name], signal);
    } catch (error) {
      signal?.throwIfAborted();
      const message = error instanceof Error ? error.message : String(error);
      if (!new RegExp(`No such ${kind}|not found`, "iu").test(message)) throw error;
    }
    this.#forgetResourceRef(kind, name);
  }

  #forgetResourceRef(kind: ManagedResourceKind, name: string): void {
    for (const [key, resource] of this.#resolvedResourceRefs) {
      if (resource.kind === kind && resource.name === name) this.#resolvedResourceRefs.delete(key);
    }
  }

  async #recoverRebuildArtifacts(
    instanceId: string,
    ownerId: string,
    restoreRunning = false,
    preserveDeferredCandidate = false,
    signal?: AbortSignal,
    storageBinding = this.#workspaceStorageBinding(instanceId, undefined),
  ): Promise<ContainerCatalogSnapshot | undefined> {
    const artifacts = await this.#inspectRebuildArtifacts(instanceId, signal);
    this.#requireRebuildArtifactOwnership(artifacts, ownerId);
    const context: RebuildRecoveryContext = {
      instanceId,
      ownerId,
      restoreRunning,
      preserveDeferredCandidate,
      signal,
      artifacts,
      storageBinding,
    };

    if (artifacts.rollback) return this.#recoverRollbackArtifact(context, artifacts.rollback);
    if (artifacts.rollbackOccupant) {
      throw new Error("unlabeled rebuild rollback artifact requires attention");
    }
    if (artifacts.canonical && artifacts.previous) {
      return this.#recoverCanonicalWithPrevious(context, artifacts.canonical, artifacts.previous);
    }
    if (artifacts.canonical) return this.#recoverCanonicalArtifact(context, artifacts.canonical);
    if (artifacts.previous) return this.#recoverPreviousArtifact(context, artifacts.previous);
    if (artifacts.candidate) {
      await this.#docker(["rm", "--force", artifacts.names.candidate], signal);
    }
    return undefined;
  }

  #rebuildArtifactNames(
    instanceId: string,
    canonicalName = this.#containerName(instanceId),
  ): RebuildArtifactNames {
    const canonical = canonicalName;
    return {
      canonical,
      candidate: `${canonical}-rebuild-next`,
      previous: `${canonical}-rebuild-previous`,
      rollback: `${canonical}-rebuild-rollback`,
    };
  }

  async #inspectRebuildArtifacts(instanceId: string, signal?: AbortSignal): Promise<RebuildArtifacts> {
    const discoveredCanonical = await this.#inspectContainer(instanceId, signal);
    const requestedName = this.#containerName(instanceId);
    const baseNames = new Set<string>([discoveredCanonical?.resourceName ?? requestedName]);
    if (!discoveredCanonical) {
      for (const prefix of this.#config.legacyNamePrefixes ?? []) {
        baseNames.add(`${prefix}${instanceId}`);
      }
    }

    let selectedBase = discoveredCanonical?.resourceName ?? null;
    let canonical = discoveredCanonical;
    let candidate: InspectedContainer | null = null;
    let previous: InspectedContainer | null = null;
    let inspectedRollback: InspectedContainer | null = null;
    for (const base of baseNames) {
      const baseArtifacts = await Promise.all([
        this.#inspectContainerByName(`${base}-rebuild-next`, instanceId, signal),
        this.#inspectContainerByName(`${base}-rebuild-previous`, instanceId, signal),
        this.#inspectContainerByName(`${base}-rebuild-rollback`, instanceId, signal),
      ]);
      if (!baseArtifacts.some(Boolean)) continue;
      if (selectedBase !== null && selectedBase !== base) {
        throw new ManagedResourceResolutionError(
          "resource_identity_ambiguous",
          { instanceId, ownerId: "unknown-owner" },
          "container",
          [selectedBase, base],
        );
      }
      selectedBase = base;
      [candidate, previous, inspectedRollback] = baseArtifacts;
    }

    // 任意自定义前缀可能不在 legacyNamePrefixes 中；只有已知名称都没有
    // 工件时才使用 label 列表补齐旁路发现，避免普通读路径增加扫描。
    if (selectedBase === null && this.#config.resourceDiscovery !== false) {
      const discoveredNames = await this.#listManagedResourceNames("container", instanceId, signal);
      const artifactNames = discoveredNames.filter(isRebuildArtifactName);
      const bases = new Set(artifactNames.map((name) => name.replace(REBUILD_ARTIFACT_SUFFIX, "")));
      if (bases.size > 1) {
        throw new ManagedResourceResolutionError(
          "resource_identity_ambiguous",
          { instanceId, ownerId: "unknown-owner" },
          "container",
          [...bases],
        );
      }
      const discoveredBase = [...bases][0];
      if (discoveredBase) {
        selectedBase = discoveredBase;
        const artifactResults = await Promise.all([
          this.#inspectContainerByName(`${discoveredBase}-rebuild-next`, instanceId, signal),
          this.#inspectContainerByName(`${discoveredBase}-rebuild-previous`, instanceId, signal),
          this.#inspectContainerByName(`${discoveredBase}-rebuild-rollback`, instanceId, signal),
        ]);
        [candidate, previous, inspectedRollback] = artifactResults;
      }
    }

    const names = this.#rebuildArtifactNames(instanceId, selectedBase ?? requestedName);
    if (!canonical) canonical = await this.#inspectContainerByName(names.canonical, instanceId, signal);
    return {
      names,
      canonical,
      candidate,
      previous,
      rollback: inspectedRollback?.rebuild ? inspectedRollback : null,
      rollbackOccupant: inspectedRollback,
    };
  }

  #requireRebuildArtifactOwnership(artifacts: RebuildArtifacts, ownerId: string): void {
    for (const [name, instance] of [
      [artifacts.names.canonical, artifacts.canonical],
      [artifacts.names.candidate, artifacts.candidate],
      [artifacts.names.previous, artifacts.previous],
      [artifacts.names.rollback, artifacts.rollbackOccupant],
    ] as const) {
      if (instance && instance.ownerId !== ownerId) throw new Error(`container ${name} ownership mismatch`);
    }
  }

  #rebuildTransactionStatus(
    artifacts: RebuildArtifacts,
    transactionId: string,
  ): ContainerRebuildTransactionStatus {
    if (!this.#rebuildArtifactsHaveSingleOwner(artifacts)) return "inconsistent";
    if (artifacts.rollbackOccupant && !artifacts.rollback) return "inconsistent";
    const canonicalRebuild = artifacts.canonical?.rebuild;
    const candidateRebuild = artifacts.candidate?.rebuild;
    const rollbackRebuild = artifacts.rollback?.rebuild;
    if (canonicalRebuild?.id === transactionId) {
      return this.#canonicalRebuildTransactionStatus(
        artifacts,
        transactionId,
        canonicalRebuild,
        candidateRebuild,
        rollbackRebuild,
      );
    }
    if (candidateRebuild?.id === transactionId) {
      return this.#sideCandidateTransactionStatus(artifacts, candidateRebuild);
    }
    if (rollbackRebuild?.id === transactionId) {
      return this.#rollbackTransactionStatus(artifacts, rollbackRebuild);
    }
    return "not_found";
  }

  #rebuildArtifactsHaveSingleOwner(artifacts: RebuildArtifacts): boolean {
    const owners = new Set(
      [
        artifacts.canonical?.ownerId,
        artifacts.candidate?.ownerId,
        artifacts.previous?.ownerId,
        artifacts.rollbackOccupant?.ownerId,
      ].filter((owner): owner is string => owner !== undefined),
    );
    return owners.size <= 1;
  }

  #canonicalRebuildTransactionStatus(
    artifacts: RebuildArtifacts,
    transactionId: string,
    canonicalRebuild: RebuildContainerMetadata,
    candidateRebuild: RebuildContainerMetadata | undefined,
    rollbackRebuild: RebuildContainerMetadata | undefined,
  ): ContainerRebuildTransactionStatus {
    if (rollbackRebuild?.id === transactionId) return "inconsistent";
    if (!artifacts.previous) {
      return candidateRebuild?.id === transactionId ? "inconsistent" : "committed";
    }
    if (canonicalRebuild.predecessorId !== requireDockerContainerId(artifacts.previous.runtimeId)) {
      return "inconsistent";
    }
    if (
      artifacts.candidate &&
      (candidateRebuild?.id !== transactionId ||
        candidateRebuild.predecessorId !== requireDockerContainerId(artifacts.previous.runtimeId))
    ) {
      return "inconsistent";
    }
    return "pending";
  }

  #sideCandidateTransactionStatus(
    artifacts: RebuildArtifacts,
    candidateRebuild: RebuildContainerMetadata,
  ): ContainerRebuildTransactionStatus {
    if (artifacts.rollback || (artifacts.canonical && artifacts.previous)) return "inconsistent";
    const predecessor = artifacts.previous ?? artifacts.canonical;
    if (!predecessor) return "inconsistent";
    return candidateRebuild.predecessorId === requireDockerContainerId(predecessor.runtimeId)
      ? "pending"
      : "inconsistent";
  }

  #rollbackTransactionStatus(
    artifacts: RebuildArtifacts,
    rollbackRebuild: RebuildContainerMetadata,
  ): ContainerRebuildTransactionStatus {
    if (artifacts.candidate || (artifacts.canonical && artifacts.previous)) return "inconsistent";
    const predecessor = artifacts.previous ?? artifacts.canonical;
    if (!predecessor) return "inconsistent";
    return rollbackRebuild.predecessorId === requireDockerContainerId(predecessor.runtimeId)
      ? "pending"
      : "inconsistent";
  }

  async #recoverRollbackArtifact(
    context: RebuildRecoveryContext,
    rollback: InspectedContainer,
  ): Promise<ContainerCatalogSnapshot | undefined> {
    const { artifacts } = context;
    if (artifacts.candidate || (artifacts.canonical && artifacts.previous)) {
      throw new Error("ambiguous rebuild rollback artifacts");
    }
    const predecessor = artifacts.previous ?? artifacts.canonical;
    const predecessorName = artifacts.previous ? artifacts.names.previous : artifacts.names.canonical;
    if (!predecessor) throw new Error("rebuild rollback predecessor is missing");
    const rollbackMetadata = this.#requireStagedReplacement(rollback, predecessor);
    await this.#fenceFailedCandidate(
      context.instanceId,
      context.ownerId,
      artifacts.names.rollback,
      artifacts.names.rollback,
      rollback.runtimeId,
      rollbackMetadata.id,
      context.storageBinding,
      context.signal,
    );
    if (predecessorName !== artifacts.names.canonical) {
      await this.#docker(["rename", predecessorName, artifacts.names.canonical], context.signal);
    }
    if (
      this.#shouldRestoreRunning(context, rollbackMetadata.startRequested) &&
      predecessor.state !== "running"
    ) {
      await this.#docker(["start", artifacts.names.canonical], context.signal);
    }
    await this.#docker(["rm", "--force", artifacts.names.rollback], context.signal);
    return rollbackMetadata.sourceCatalogSnapshot;
  }

  async #recoverCanonicalWithPrevious(
    context: RebuildRecoveryContext,
    canonical: InspectedContainer,
    previous: InspectedContainer,
  ): Promise<ContainerCatalogSnapshot | undefined> {
    const { artifacts } = context;
    // canonical 与 previous 同时存在时，只有 candidate 标签中的
    // predecessor/transaction 关系能证明它们属于同一受管替换。
    const canonicalRebuild = this.#requireStagedReplacement(canonical, previous);
    if (artifacts.candidate) {
      const candidateRebuild = this.#requireStagedReplacement(artifacts.candidate, previous);
      if (candidateRebuild.id !== canonicalRebuild.id) {
        throw new Error("rebuild transaction metadata mismatch");
      }
      await this.#docker(["rm", "--force", artifacts.names.candidate], context.signal);
    }
    if (await this.#commitHealthyCanonical(context, canonical)) return undefined;
    if (
      context.preserveDeferredCandidate &&
      !canonicalRebuild.startRequested &&
      canonical.state !== "running"
    ) {
      // stopped rebuild 的候选是有意保留的延迟提交；首次 start 会在
      // Docker start() 中执行健康探针，get/sync 不应提前回滚它。
      return undefined;
    }
    await this.#fenceFailedCandidate(
      context.instanceId,
      context.ownerId,
      artifacts.names.canonical,
      artifacts.names.rollback,
      canonical.runtimeId,
      canonicalRebuild.id,
      context.storageBinding,
      context.signal,
    );
    await this.#docker(["rename", artifacts.names.previous, artifacts.names.canonical], context.signal);
    const startRequested = canonicalRebuild.startRequested || canonical.state === "running";
    if (this.#shouldRestoreRunning(context, startRequested) && previous.state !== "running") {
      await this.#docker(["start", artifacts.names.canonical], context.signal);
    }
    await this.#docker(["rm", "--force", artifacts.names.rollback], context.signal);
    return canonicalRebuild.sourceCatalogSnapshot;
  }

  async #commitHealthyCanonical(
    context: RebuildRecoveryContext,
    canonical: InspectedContainer,
  ): Promise<boolean> {
    if (canonical.state !== "running" || !canonical.rebuild) return false;
    try {
      await this.#probeContainerHealth(context.artifacts.names.canonical, context.signal);
    } catch {
      if (context.signal?.aborted) throw context.signal.reason;
      return false;
    }
    try {
      await this.#removeRebuildPredecessor(
        context.instanceId,
        context.ownerId,
        canonical.runtimeId,
        canonical.rebuild,
        context.signal,
      );
      return true;
    } catch {
      if (context.signal?.aborted) throw context.signal.reason;
      // 删除结果不确定时只有可验证的提交后置条件才能保留 candidate。
      return false;
    }
  }

  async #recoverCanonicalArtifact(
    context: RebuildRecoveryContext,
    canonical: InspectedContainer,
  ): Promise<ContainerCatalogSnapshot | undefined> {
    const { artifacts } = context;
    if (!artifacts.candidate) {
      if (context.restoreRunning && canonical.state !== "running") {
        await this.#docker(["start", artifacts.names.canonical], context.signal);
      }
      return undefined;
    }
    // side candidate 从未启动，不会持有状态锁；先保留为 tombstone，旧代
    // 恢复完成后再删除，覆盖 stop 后尚未 rename 的崩溃窗口。
    const candidateRebuild = this.#requireStagedReplacement(artifacts.candidate, canonical);
    await this.#docker(["rename", artifacts.names.candidate, artifacts.names.rollback], context.signal);
    if (
      this.#shouldRestoreRunning(context, candidateRebuild.startRequested) &&
      canonical.state !== "running"
    ) {
      await this.#docker(["start", artifacts.names.canonical], context.signal);
    }
    await this.#docker(["rm", "--force", artifacts.names.rollback], context.signal);
    return candidateRebuild.sourceCatalogSnapshot;
  }

  async #recoverPreviousArtifact(
    context: RebuildRecoveryContext,
    previous: InspectedContainer,
  ): Promise<ContainerCatalogSnapshot | undefined> {
    const { artifacts } = context;
    let candidateRebuild: RebuildContainerMetadata | undefined;
    if (artifacts.candidate) {
      candidateRebuild = this.#requireStagedReplacement(artifacts.candidate, previous);
      await this.#docker(["rename", artifacts.names.candidate, artifacts.names.rollback], context.signal);
    }
    await this.#docker(["rename", artifacts.names.previous, artifacts.names.canonical], context.signal);
    if (
      this.#shouldRestoreRunning(context, candidateRebuild?.startRequested === true) &&
      previous.state !== "running"
    ) {
      await this.#docker(["start", artifacts.names.canonical], context.signal);
    }
    if (candidateRebuild) {
      await this.#docker(["rm", "--force", artifacts.names.rollback], context.signal);
    }
    return candidateRebuild?.sourceCatalogSnapshot;
  }

  #shouldRestoreRunning(context: RebuildRecoveryContext, startRequested: boolean): boolean {
    return context.restoreRunning || (context.preserveDeferredCandidate && startRequested);
  }

  #requireStagedReplacement(
    canonical: InspectedContainer,
    previous: InspectedContainer,
  ): RebuildContainerMetadata {
    if (canonical.ownerId !== previous.ownerId) throw new Error("rebuild container ownership mismatch");
    const rebuild = canonical.rebuild;
    if (!rebuild || rebuild.predecessorId !== requireDockerContainerId(previous.runtimeId)) {
      throw new Error("rebuild predecessor metadata mismatch");
    }
    return rebuild;
  }

  async #connectPortal(
    instanceId: string,
    signal?: AbortSignal,
    networkName = this.#networkName(instanceId),
  ): Promise<void> {
    const portalContainer = this.#config.portalContainer;
    if (!portalContainer) throw new Error("Portal container is not configured for network endpoint mode");
    try {
      await this.#docker(["network", "connect", networkName, portalContainer], signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists in network|already connected/i.test(message)) throw error;
    }
  }

  async #disconnectPortal(
    instanceId: string,
    signal?: AbortSignal,
    networkName = this.#networkName(instanceId),
  ): Promise<void> {
    const portalContainer = this.#config.portalContainer;
    if (!portalContainer) throw new Error("Portal container is not configured for network endpoint mode");
    try {
      await this.#docker(["network", "disconnect", "--force", networkName, portalContainer], signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/is not connected|not found|No such (network|container)/i.test(message)) throw error;
    }
  }

  #toInstance(
    inspect: DockerInspect,
    expectedInstanceId: string,
    actualName = this.#containerName(expectedInstanceId),
  ): InspectedContainer {
    const labels = inspect.Config.Labels ?? {};
    const ownerId = this.#requireManagedLabels(labels, expectedInstanceId, undefined, "container");
    const instanceId = expectedInstanceId;

    let endpoint: string | null = null;
    if (this.#config.endpointMode === "network") {
      endpoint = `http://${actualName}:${this.#profile().containerPort}`;
    } else {
      const binding = inspect.NetworkSettings.Ports?.[this.#portKey()]?.[0];
      if (binding?.HostPort) endpoint = `http://127.0.0.1:${binding.HostPort}`;
    }

    const instance: InspectedContainer = {
      instanceId,
      ownerId,
      runtimeId: inspect.Id,
      state: mapState(inspect.State.Status),
      endpoint,
      createdAt: inspect.Created,
      ...catalogSnapshotMetadata(labels, "", this.#labelPrefixes()),
      ...rebuildMetadata(labels, this.#labelPrefixes()),
    };
    const containerHostname = readDockerContainerHostname(inspect.Config.Hostname);
    if (containerHostname) instance.containerHostname = containerHostname;
    const scheme = resourceLabel(labels, "resource-scheme", this.#labelPrefixes());
    if (scheme) instance.resourceScheme = scheme;
    if (actualName !== `${this.#config.namePrefix}${instanceId}`) instance.resourceName = actualName;
    return instance;
  }
}
