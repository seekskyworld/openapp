import { randomUUID } from "node:crypto";
import {
  provisioningPolicyFromDefaults,
  normalizeProvisioningPolicy,
  normalizeProvisioningPolicyWithFallback,
  type ProvisioningPolicy,
} from "../instance-policy.js";
import { ConfigRevisionConflictError, UserRoleUpdateError } from "../models.js";
import { leaseRetryDelayMs, leaseWaitMs, waitForLeaseRetry, type MaintenanceLeaseOptions } from "../maintenance-lease.js";
import type {
  AccountAuthState,
  AppDefinition,
  AppVersion,
  AuthenticatedUser,
  AuthMethod,
  BuildPackage,
  BuildStrategy,
  ConfigRevision,
  ConfigRevisionInput,
  ConfigRevisionSnapshot,
  Container,
  ForwardingPolicy,
  ImageArtifact,
  ImageBuild,
  ImageBuildStatus,
  ManagedLocalUserCreateInput,
  User,
  UserRoleChangeInput,
  Tenant,
  TenantMembership,
  TenantMembershipRole,
  WorkspaceTenantBinding,
} from "../models.js";
import type { AuthProviderId } from "../auth/types.js";
import type { AuditEvent, AuditEventFilter, HealthCheck, RuntimeSample } from "../monitoring-types.js";
import type { AdminOperation, AdminOperationFilter } from "../admin-operations.js";
import type { InstanceActivityLease, InstanceDrainRequest } from "../instance-upgrade-activity.js";
import type {
  UpgradeRollout,
  UpgradeRolloutDetail,
  UpgradeRolloutItem,
  UpgradeRolloutTargetReference,
} from "../upgrade-rollouts.js";
import { withVersionPackageProjection } from "../app-version-packages.js";
import { redactSensitiveMetadata } from "../sensitive-data.js";
import { assertCanCreateManagedUser, assertCanGovernUserRoles } from "../user-role-policy.js";
import type { WorkspaceExecutionProjection } from "../workspace-execution.js";
import {
  assertWorkspaceExecutionTransition,
  projectContainerToWorkspaceExecution,
  projectWorkspaceExecutionToContainer,
  WorkspaceExecutionCasRequiredError,
} from "../workspace-execution-model.js";
import type {
  Persistence,
  PersistenceCompatibilityDefaults,
  PersistenceInitializeOptions,
} from "./contracts.js";
import { personalTenantId } from "../tenant-membership.js";

type MemorySession = { userId: string; expiresAt: number; authMethod: AuthMethod };

/** 面向本地开发和契约测试的显式内存适配器。 */
export class MemoryPersistence implements Persistence {
  #defaultAuthProvider: AuthProviderId | "local";
  readonly #users = new Map<string, User>();
  readonly #sessions = new Map<string, MemorySession>();
  readonly #identities = new Map<string, string>();
  readonly #localPasswordHashes = new Map<string, string>();
  readonly #containers = new Map<string, Container>();
  readonly #workspaceExecutions = new Map<string, WorkspaceExecutionProjection>();
  readonly #apps = new Map<string, AppDefinition>();
  readonly #appVersions = new Map<string, AppVersion>();
  readonly #buildStrategies = new Map<string, BuildStrategy>();
  readonly #buildPackages = new Map<string, BuildPackage>();
  readonly #imageBuilds = new Map<string, ImageBuild>();
  readonly #imageArtifacts = new Map<string, ImageArtifact>();
  readonly #forwardingPolicies = new Map<string, ForwardingPolicy>();
  readonly #configRevisions = new Map<string, ConfigRevision>([
    ["instance-policy", initialConfigRevision("instance-policy")],
    ["forwarding:default", initialConfigRevision("forwarding:default")],
  ]);
  readonly #configHistory = new Map<string, ConfigRevisionSnapshot[]>();
  readonly #runtimeSamples = new Map<string, RuntimeSample[]>();
  readonly #healthChecks = new Map<string, HealthCheck[]>();
  readonly #auditEvents: AuditEvent[] = [];
  readonly #operations = new Map<string, AdminOperation>();
  readonly #upgradeRollouts = new Map<string, UpgradeRollout>();
  readonly #upgradeRolloutItems = new Map<string, UpgradeRolloutItem>();
  readonly #instanceActivityLeases = new Map<string, InstanceActivityLease>();
  readonly #instanceUpgradeDrains = new Map<string, { rolloutId: string; attemptId: string; expiresAt: string }>();
  readonly #tenants = new Map<string, Tenant>();
  readonly #tenantMemberships = new Map<string, TenantMembership>();
  readonly #workspaceTenantBindings = new Map<string, WorkspaceTenantBinding>();
  readonly #maintenanceLeases = new Set<string>();
  /**
   * 内存适配器的方法仍然是异步的。将同一实例的租约和 drain 变更放入单一
   * 队列，避免在观察 drain 和写入租约之间让出执行权。
   */
  readonly #instanceActivityLocks = new Map<string, Promise<void>>();
  #provisioningPolicy: ProvisioningPolicy | undefined;
  #provisioningPolicyFallback: ProvisioningPolicy | undefined;

  constructor(options: {
    /** @deprecated 保留旧调用方参数；不会再改变任何产品默认值。 */
    legacyCompatibility?: boolean;
    defaultAuthProvider?: AuthProviderId | "local";
    compatibilityDefaults?: PersistenceCompatibilityDefaults;
    strategyDefinitions?: readonly BuildStrategy[];
    provisioningPolicyFallback?: ProvisioningPolicy;
  } = {}) {
    this.#defaultAuthProvider = normalizeAuthProvider(
      options.compatibilityDefaults?.authProvider
        ?? options.defaultAuthProvider
        ?? "external",
    );
    this.#provisioningPolicyFallback = options.provisioningPolicyFallback
      ? structuredClone(options.provisioningPolicyFallback)
      : undefined;
    for (const strategy of options.strategyDefinitions ?? []) {
      this.#buildStrategies.set(strategy.id.trim().toLowerCase(), structuredClone(strategy));
    }
  }

  async initialize(options?: PersistenceInitializeOptions): Promise<void> {
    if (options?.compatibilityDefaults?.authProvider !== undefined) {
      this.#defaultAuthProvider = normalizeAuthProvider(options.compatibilityDefaults.authProvider);
    } else if (options?.defaultAuthProvider !== undefined) {
      this.#defaultAuthProvider = normalizeAuthProvider(options.defaultAuthProvider);
    }
    if (options?.provisioningPolicyDefaults !== undefined
      && Object.keys(options.provisioningPolicyDefaults).length > 0
      && !this.#provisioningPolicy) {
      this.#provisioningPolicy = provisioningPolicyFromDefaults(options.provisioningPolicyDefaults);
      this.#provisioningPolicyFallback = structuredClone(this.#provisioningPolicy);
    }
    if (options?.strategyDefinitions === undefined) return;

    for (const strategy of options.strategyDefinitions) {
      const normalized = structuredClone(strategy);
      this.#buildStrategies.set(normalized.id.trim().toLowerCase(), normalized);
    }
  }

  async getProvisioningPolicy(): Promise<ProvisioningPolicy> {
    if (this.#provisioningPolicy) {
      return normalizeProvisioningPolicyWithFallback(
        this.#provisioningPolicy,
        this.#provisioningPolicyFallback ?? this.#provisioningPolicy,
      );
    }
    // 显式注入的 fallback 属于当前组合根的配置；只有完全没有 fallback
    // 时才报未初始化，不能把“是否 legacy”当成策略是否可用的隐式开关。
    if (!this.#provisioningPolicyFallback) {
      throw new Error("provisioning_policy_not_initialized");
    }
    return normalizeProvisioningPolicyWithFallback(
      this.#provisioningPolicyFallback,
      this.#provisioningPolicyFallback,
    );
  }

  async saveProvisioningPolicy(policy: ProvisioningPolicy, revision: ConfigRevisionInput = {}): Promise<ProvisioningPolicy> {
    const snapshot = structuredClone(policy);
    await this.saveConfigRevision("instance-policy", { ...revision, payload: snapshot });
    this.#provisioningPolicy = snapshot;
    this.#provisioningPolicyFallback ??= structuredClone(snapshot);
    return structuredClone(this.#provisioningPolicy);
  }

  async getConfigRevision(key: string): Promise<ConfigRevision | null> {
    return clone(this.#configRevisions.get(key) ?? null);
  }

  async saveConfigRevision(key: string, input: ConfigRevisionInput = {}): Promise<ConfigRevision> {
    const now = new Date().toISOString();
    const current = this.#configRevisions.get(key);
    if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.revision ?? 0)) {
      throw new ConfigRevisionConflictError();
    }
    const payload = clone(input.payload ?? null);
    const revision: ConfigRevision = {
      key,
      revision: (current?.revision ?? 0) + 1,
      updatedBy: input.updatedBy?.trim() || "system",
      updatedAt: now,
      effect: input.effect ?? "immediate",
      effectiveAt: input.effectiveAt === undefined ? now : input.effectiveAt,
    };
    const history = this.#configHistory.get(key) ?? [];
    history.unshift({ ...clone(revision)!, payload });
    history.splice(100);
    this.#configRevisions.set(key, revision);
    this.#configHistory.set(key, history);
    return clone(revision)!;
  }

  async listConfigRevisions(key: string, limit = 50): Promise<ConfigRevisionSnapshot[]> {
    return clone((this.#configHistory.get(key) ?? []).slice(0, clampLimit(limit)))!;
  }

  async getConfigRevisionSnapshot(key: string, revision: number): Promise<ConfigRevisionSnapshot | null> {
    return clone((this.#configHistory.get(key) ?? []).find((item) => item.revision === revision) ?? null);
  }

  async touchContainer(id: string, at = new Date()): Promise<void> {
    const container = this.#containers.get(id);
    const projection = this.#workspaceExecutions.get(id);
    if (!container || projection?.workspace.status !== "active") return;
    const touchedAt = at.toISOString();
    container.lastActivityAt = touchedAt;
    if (projection) projection.execution.lastActivityAt = touchedAt;
  }

  async markUserAppInitialized(id: string): Promise<void> {
    const user = this.#users.get(id);
    if (user) user.appInitializedAt ??= new Date().toISOString();
  }

  async getUser(id: string): Promise<User | null> {
    return clone(this.#users.get(id) ?? null);
  }

  async withInstanceCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async withReleaseActivationLock<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  async withMaintenanceLease<T>(name: string, operation: (signal: AbortSignal) => Promise<T>, options: MaintenanceLeaseOptions = {}): Promise<T | null> {
    const deadline = Date.now() + leaseWaitMs(options.waitMs);
    while (this.#maintenanceLeases.has(name) && Date.now() < deadline) {
      await waitForLeaseRetry(Math.min(leaseRetryDelayMs(options.retryDelayMs), Math.max(1, deadline - Date.now())), options.signal);
    }
    options.signal?.throwIfAborted();
    if (this.#maintenanceLeases.has(name)) return null;
    this.#maintenanceLeases.add(name);
    try {
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      return await operation(signal);
    } finally {
      this.#maintenanceLeases.delete(name);
    }
  }

  async listApps(): Promise<AppDefinition[]> {
    return [...this.#apps.values()].sort((left, right) => left.name.localeCompare(right.name)).map((app) => clone(app)!);
  }

  async getApp(appId: string): Promise<AppDefinition | null> {
    return clone(this.#apps.get(appId.trim().toLowerCase()) ?? null);
  }

  async createApp(app: AppDefinition): Promise<AppDefinition | null> {
    const id = app.id.trim().toLowerCase();
    if (this.#apps.has(id)) return null;
    const value = { ...clone(app)!, id };
    this.#apps.set(id, value);
    return clone(value)!;
  }

  async updateApp(app: AppDefinition): Promise<AppDefinition | null> {
    const id = app.id.trim().toLowerCase();
    if (!this.#apps.has(id)) return null;
    const value = { ...clone(app)!, id, updatedAt: app.updatedAt };
    this.#apps.set(id, value);
    return clone(value)!;
  }

  async listAppVersions(appId: string): Promise<AppVersion[]> {
    return [...this.#appVersions.values()]
      .filter((version) => version.appId === appId.trim().toLowerCase())
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))
      .map((version) => clone(version)!);
  }

  async getAppVersion(id: string): Promise<AppVersion | null> {
    return clone(this.#appVersions.get(id) ?? null);
  }

  async saveAppVersion(version: AppVersion): Promise<AppVersion | null> {
    if (!this.#apps.has(version.appId)) throw new Error("app_not_found");
    if (version.packages?.some((item) => item.packageId && !this.#buildPackages.has(item.packageId))) {
      throw new Error("build_package_not_found");
    }
    const duplicate = [...this.#appVersions.values()].find((item) => item.appId === version.appId && item.version === version.version && item.id !== version.id);
    if (duplicate) return null;
    const current = this.#appVersions.get(version.id);
    const nextRevision = Math.max(0, ...[...this.#appVersions.values()]
      .filter((item) => item.appId === version.appId)
      .map((item) => item.revision ?? 0)) + 1;
    const value = withVersionPackageProjection({
      ...clone(version)!,
      revision: current?.appId === version.appId ? current.revision ?? nextRevision : nextRevision,
    });
    this.#appVersions.set(value.id, value);
    return clone(value)!;
  }

  async activateAppVersion(
    appId: string,
    versionId: string,
    expectedCurrentVersionId?: string | null,
  ): Promise<AppVersion | null> {
    const app = appId.trim().toLowerCase();
    const target = this.#appVersions.get(versionId);
    if (!target || target.appId !== app) return null;
    const appVersions = [...this.#appVersions.values()]
      .filter((version) => version.appId === app)
      .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0));
    const currentVersionId = appVersions.find((version) => version.status === "active")?.id
      ?? appVersions.find((version) => version.status === "legacy")?.id
      ?? null;
    if (expectedCurrentVersionId !== undefined && expectedCurrentVersionId !== currentVersionId) return null;
    for (const version of this.#appVersions.values()) {
      if (version.appId !== app) continue;
      if (version.id === versionId) {
        version.status = "active";
        version.activatedAt = new Date().toISOString();
      } else if (version.status === "active") {
        version.status = version.imageReference ? "image_ready" : "uploaded";
        version.activatedAt = null;
      }
    }
    return clone(target)!;
  }

  async listBuildStrategies(): Promise<BuildStrategy[]> {
    return [...this.#buildStrategies.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((strategy) => clone(strategy)!);
  }

  async getBuildStrategy(id: string): Promise<BuildStrategy | null> {
    return clone(this.#buildStrategies.get(id.trim().toLowerCase()) ?? null);
  }

  async saveBuildStrategy(strategy: BuildStrategy): Promise<BuildStrategy> {
    const value = { ...clone(strategy)!, id: strategy.id.trim().toLowerCase() };
    this.#buildStrategies.set(value.id, value);
    return clone(value)!;
  }

  async listBuildPackages(strategyId?: string, key?: string, limit?: number): Promise<BuildPackage[]> {
    const normalizedStrategyId = strategyId?.trim().toLowerCase();
    const normalizedKey = key?.trim().toLowerCase();
    const packages = [...this.#buildPackages.values()]
      .filter((pkg) => !normalizedStrategyId || pkg.strategyId === normalizedStrategyId)
      .filter((pkg) => !normalizedKey || pkg.key === normalizedKey)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return (limit === undefined ? packages : packages.slice(0, clampLimit(limit)))
      .map((pkg) => clone(pkg)!);
  }

  async getBuildPackage(id: string): Promise<BuildPackage | null> {
    return clone(this.#buildPackages.get(id) ?? null);
  }

  async createBuildPackage(pkg: BuildPackage): Promise<BuildPackage | null> {
    if (this.#buildPackages.has(pkg.id)) return null;
    if (!this.#buildStrategies.has(pkg.strategyId)) throw new Error("build_strategy_not_found");
    const value = {
      ...clone(pkg)!,
      sourceVersion: pkg.sourceVersion ?? null,
      sourceBuildId: pkg.sourceBuildId ?? null,
      inspectedAt: pkg.inspectedAt ?? null,
    };
    this.#buildPackages.set(value.id, value);
    return clone(value)!;
  }

  async deleteBuildPackageIfUnreferenced(id: string): Promise<BuildPackage | null> {
    const pkg = this.#buildPackages.get(id);
    if (!pkg) return null;
    const referencedByVersion = [...this.#appVersions.values()]
      .some((version) => version.packages?.some((item) => item.packageId === id));
    const referencedByBuild = [...this.#imageBuilds.values()]
      .some((build) => build.packages.some((item) => item.packageId === id));
    if (referencedByVersion || referencedByBuild) return null;
    this.#buildPackages.delete(id);
    return clone(pkg)!;
  }

  async listImageBuilds(strategyId?: string, limit?: number): Promise<ImageBuild[]> {
    const normalizedStrategyId = strategyId?.trim().toLowerCase();
    const builds = [...this.#imageBuilds.values()]
      .filter((build) => !normalizedStrategyId || build.strategyId === normalizedStrategyId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return (limit === undefined ? builds : builds.slice(0, clampLimit(limit)))
      .map((build) => clone(build)!);
  }

  async getImageBuild(id: string): Promise<ImageBuild | null> {
    return clone(this.#imageBuilds.get(id) ?? null);
  }

  async createImageBuild(build: ImageBuild): Promise<ImageBuild | null> {
    if (this.#imageBuilds.has(build.id)) return null;
    if (!this.#buildStrategies.has(build.strategyId)) throw new Error("build_strategy_not_found");
    if (build.sourceAppVersionId && !this.#appVersions.has(build.sourceAppVersionId)) throw new Error("app_version_not_found");
    if (build.operationId && !this.#operations.has(build.operationId)) throw new Error("operation_not_found");
    if (build.packages.some((item) => item.packageId && !this.#buildPackages.has(item.packageId))) {
      throw new Error("build_package_not_found");
    }
    const value = clone(build)!;
    this.#imageBuilds.set(value.id, value);
    return clone(value)!;
  }

  async updateImageBuild(build: ImageBuild, expectedStatus: ImageBuildStatus): Promise<ImageBuild | null> {
    const current = this.#imageBuilds.get(build.id);
    if (!current || current.status !== expectedStatus) return null;
    const value = clone(build)!;
    this.#imageBuilds.set(value.id, value);
    return clone(value)!;
  }

  async recoverInterruptedImageBuilds(finishedAt: string): Promise<number> {
    let recovered = 0;
    for (const [id, build] of this.#imageBuilds) {
      if (build.status !== "queued" && build.status !== "building") continue;
      const operation = build.operationId ? this.#operations.get(build.operationId) : null;
      if (operation && (operation.status === "queued" || operation.status === "running")) continue;
      this.#imageBuilds.set(id, {
        ...build,
        status: "failed",
        error: "image_build_interrupted",
        finishedAt,
      });
      recovered += 1;
    }
    return recovered;
  }

  async completeImageBuild(
    build: ImageBuild,
    artifact: ImageArtifact,
    expectedStatus: ImageBuildStatus,
  ): Promise<{ build: ImageBuild; artifact: ImageArtifact } | null> {
    const current = this.#imageBuilds.get(build.id);
    if (!current || current.status !== expectedStatus || artifact.buildId !== build.id) return null;
    if (this.#imageArtifacts.has(artifact.id)
      || [...this.#imageArtifacts.values()].some((candidate) => candidate.buildId === artifact.buildId)) return null;
    const savedBuild = clone(build)!;
    const savedArtifact = clone(artifact)!;
    this.#imageBuilds.set(savedBuild.id, savedBuild);
    this.#imageArtifacts.set(savedArtifact.id, savedArtifact);
    return { build: clone(savedBuild)!, artifact: clone(savedArtifact)! };
  }

  async getImageArtifact(id: string): Promise<ImageArtifact | null> {
    return clone(this.#imageArtifacts.get(id) ?? null);
  }

  async getImageArtifactForBuild(buildId: string): Promise<ImageArtifact | null> {
    return clone([...this.#imageArtifacts.values()].find((artifact) => artifact.buildId === buildId) ?? null);
  }

  async listImageArtifacts(limit?: number): Promise<ImageArtifact[]> {
    const artifacts = [...this.#imageArtifacts.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return (limit === undefined ? artifacts : artifacts.slice(0, clampLimit(limit)))
      .map((artifact) => clone(artifact)!);
  }

  async deleteImageArtifactIfUnreferenced(id: string): Promise<ImageArtifact | null> {
    const artifact = this.#imageArtifacts.get(id);
    if (!artifact) return null;
    const referencedByVersion = [...this.#appVersions.values()]
      .some((version) => version.imageArtifactId === id);
    const referencedByContainer = [...this.#containers.values()]
      .some((container) => container.imageArtifactId === id);
    const referencedByActiveRollout = [...this.#upgradeRolloutItems.values()].some((item) => (
      retainsUpgradeRolloutTarget(item)
      && (item.sourceImageArtifactId === id
        || item.sourceImageReference === artifact.imageReference
        || item.sourceImageReference === artifact.imageId
        || item.targetImageArtifactId === id
        || item.targetImageReference === artifact.imageReference
        || item.targetImageReference === artifact.imageId)
    ));
    if (referencedByVersion || referencedByContainer || referencedByActiveRollout) return null;
    this.#imageArtifacts.delete(id);
    return clone(artifact)!;
  }

  async bindAppVersionArtifact(appId: string, versionId: string, artifactId: string): Promise<AppVersion | null> {
    const app = this.#apps.get(appId.trim().toLowerCase());
    const version = this.#appVersions.get(versionId);
    const artifact = this.#imageArtifacts.get(artifactId);
    if (!app || app.status !== "active" || !version || version.appId !== app.id || !artifact) return null;
    if (version.status !== "uploaded") return null;
    const updated: AppVersion = {
      ...version,
      imageArtifactId: artifact.id,
      imageReference: artifact.imageId,
      runtimeContract: artifact.runtimeContract,
      status: "image_ready",
    };
    this.#appVersions.set(versionId, updated);
    return clone(updated)!;
  }

  async upsertForwardingPolicy(
    policy: Omit<ForwardingPolicy, "updatedAt">,
    revision: ConfigRevisionInput = {},
  ): Promise<ForwardingPolicy> {
    const updated = { ...policy, allowedHosts: [...policy.allowedHosts], updatedAt: new Date().toISOString() };
    await this.saveConfigRevision(`forwarding:${policy.id}`, {
      ...revision,
      updatedBy: policy.updatedBy,
      effect: "immediate",
      payload: { targetBaseUrl: policy.targetBaseUrl, allowedHosts: policy.allowedHosts, enabled: policy.enabled },
    });
    this.#forwardingPolicies.set(policy.id, updated);
    return clone(updated)!;
  }

  async listForwardingPolicies(): Promise<ForwardingPolicy[]> {
    return [...this.#forwardingPolicies.values()].map((policy) => ({ ...policy, allowedHosts: [...policy.allowedHosts] }));
  }

  async recordAudit(
    actorUserId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata: unknown = {},
  ): Promise<void> {
    this.#auditEvents.unshift({
      id: randomUUID(),
      actorUserId,
      action,
      resourceType,
      resourceId,
      metadata: clone(redactSensitiveMetadata(metadata)),
      createdAt: new Date().toISOString(),
    });
    this.#auditEvents.splice(500);
  }

  async recordRuntimeSample(sample: RuntimeSample): Promise<void> {
    const values = this.#runtimeSamples.get(sample.instanceId) ?? [];
    values.unshift(clone(sample));
    values.splice(120);
    this.#runtimeSamples.set(sample.instanceId, values);
  }

  async listRuntimeSamples(instanceId: string, limit = 60): Promise<RuntimeSample[]> {
    const bounded = clampLimit(limit);
    return (this.#runtimeSamples.get(instanceId) ?? []).slice(0, bounded).map((sample) => clone(sample));
  }

  async listLatestRuntimeSamples(instanceIds: readonly string[]): Promise<RuntimeSample[]> {
    const result: RuntimeSample[] = [];
    for (const instanceId of instanceIds) {
      const sample = this.#runtimeSamples.get(instanceId)?.[0];
      if (sample) result.push(clone(sample));
    }
    return result;
  }

  async recordHealthCheck(check: HealthCheck): Promise<void> {
    const values = this.#healthChecks.get(check.target) ?? [];
    values.unshift(clone(check));
    values.splice(120);
    this.#healthChecks.set(check.target, values);
  }

  async listHealthChecks(target?: string, limit = 60): Promise<HealthCheck[]> {
    const bounded = clampLimit(limit);
    const values = target
      ? (this.#healthChecks.get(target) ?? [])
      : [...this.#healthChecks.values()].flat().sort((left, right) => right.checkedAt.localeCompare(left.checkedAt));
    return values.slice(0, bounded).map((check) => clone(check));
  }

  async listAuditEvents(filter: AuditEventFilter = {}): Promise<AuditEvent[]> {
    const from = filter.from?.getTime();
    const to = filter.to?.getTime();
    const values = this.#auditEvents
      .filter((event) => (!filter.actorUserId || event.actorUserId === filter.actorUserId))
      .filter((event) => (!filter.action || event.action === filter.action))
      .filter((event) => (!filter.resourceType || event.resourceType === filter.resourceType))
      .filter((event) => (!filter.resourceId || event.resourceId === filter.resourceId))
      .filter((event) => (from === undefined || Date.parse(event.createdAt) >= from))
      .filter((event) => (to === undefined || Date.parse(event.createdAt) <= to));
    const offset = clampOffset(filter.offset);
    return values.slice(offset, offset + clampLimit(filter.limit ?? 100)).map((event) => clone(event));
  }

  async saveOperation(operation: AdminOperation): Promise<void> {
    this.#operations.set(operation.id, clone(operation)!);
    this.#pruneOperations();
  }

  async createOperation(operation: AdminOperation): Promise<{ operation: AdminOperation; created: boolean }> {
    if (operation.idempotencyKey) {
      const existing = [...this.#operations.values()].find((candidate) =>
        candidate.actorUserId === operation.actorUserId && candidate.idempotencyKey === operation.idempotencyKey,
      );
      if (existing) return { operation: clone(existing)!, created: false };
    }
    this.#operations.set(operation.id, clone(operation)!);
    this.#pruneOperations();
    return { operation: clone(operation)!, created: true };
  }

  async compareAndSaveOperation(operation: AdminOperation, expectedRevision: number): Promise<AdminOperation | null> {
    const current = this.#operations.get(operation.id);
    if (!current || current.revision !== expectedRevision) return null;
    const updated = { ...clone(operation), revision: expectedRevision + 1 };
    this.#operations.set(updated.id, updated);
    return clone(updated);
  }

  async recoverStaleOperations(cutoff: string, finishedAt: string): Promise<string[]> {
    const recovered: string[] = [];
    for (const [id, current] of this.#operations) {
      if (current.status !== "queued" && current.status !== "running") continue;
      if (Date.parse(current.heartbeatAt ?? current.startedAt ?? current.createdAt) > Date.parse(cutoff)) continue;
      this.#operations.set(id, {
        ...current,
        revision: current.revision + 1,
        status: "failed",
        stage: "interrupted",
        error: "portal_restarted",
        cancellable: false,
        retryable: false,
        heartbeatAt: finishedAt,
        finishedAt,
      });
      recovered.push(id);
    }
    return recovered;
  }

  async getOperation(id: string): Promise<AdminOperation | null> {
    return clone(this.#operations.get(id) ?? null);
  }

  async listOperations(filter: AdminOperationFilter = {}): Promise<AdminOperation[]> {
    return [...this.#operations.values()]
      .filter((operation) => !filter.status || operation.status === filter.status)
      .filter((operation) => !filter.type || operation.type === filter.type)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, clampLimit(filter.limit ?? 100))
      .map((operation) => clone(operation)!);
  }

  async findOperationByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<AdminOperation | null> {
    return clone([...this.#operations.values()].find((operation) =>
      operation.actorUserId === actorUserId && operation.idempotencyKey === idempotencyKey,
    ) ?? null);
  }

  async pruneFinishedOperations(retentionMs = 30 * 24 * 60 * 60 * 1_000): Promise<number> {
    const cutoff = Date.now() - Math.max(0, retentionMs);
    let removed = 0;
    for (const [id, operation] of this.#operations) {
      if (!["succeeded", "failed", "cancelled"].includes(operation.status)) continue;
      if (Date.parse(operation.finishedAt ?? operation.createdAt) >= cutoff) continue;
      this.#operations.delete(id);
      removed += 1;
    }
    return removed;
  }

  #pruneOperations(): void {
    if (this.#operations.size <= 1_000) return;
    const stale = [...this.#operations.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (stale) this.#operations.delete(stale.id);
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const normalizedEmail = email.trim().toLowerCase();
    return clone([...this.#users.values()].find((user) => user.email === normalizedEmail) ?? null);
  }

  async findUserByIdentity(provider: AuthProviderId | "local", subject: string): Promise<User | null> {
    const userId = this.#identities.get(identityKey(provider, subject));
    return clone(userId ? this.#users.get(userId) ?? null : null);
  }

  async findOrCreateUser(
    email: string,
    preferredId?: string,
    provider?: AuthProviderId | "local",
  ): Promise<User> {
    const normalizedEmail = email.trim().toLowerCase();
    const subject = preferredId?.trim() || normalizedEmail;
    const identityProvider = provider ?? this.#defaultAuthProvider;
    const identity = identityKey(identityProvider, subject);
    const identityUserId = this.#identities.get(identity);
    if (identityUserId) {
      const identityUser = this.#users.get(identityUserId);
      if (!identityUser) throw new Error("identity_user_missing");
      identityUser.email = normalizedEmail;
      return clone(identityUser)!;
    }
    const existing = [...this.#users.values()].find((user) => user.email === normalizedEmail);
    if (existing) {
      this.#identities.set(identity, existing.id);
      return clone(existing)!;
    }
    const user: User = {
      id: randomUUID(),
      email: normalizedEmail,
      role: "user",
      createdAt: new Date().toISOString(),
      appInitializedAt: null,
    };
    this.#users.set(user.id, user);
    this.#identities.set(identity, user.id);
    return clone(user)!;
  }

  async createLocalUser(email: string, passwordHash: string): Promise<User | null> {
    const normalizedEmail = email.trim().toLowerCase();
    if ([...this.#users.values()].some((user) => user.email === normalizedEmail)) return null;
    const user: User = {
      id: randomUUID(),
      email: normalizedEmail,
      role: "user",
      createdAt: new Date().toISOString(),
      appInitializedAt: null,
    };
    this.#users.set(user.id, user);
    this.#identities.set(identityKey("local", normalizedEmail), user.id);
    this.#localPasswordHashes.set(user.id, passwordHash);
    return clone(user);
  }

  async createManagedLocalUser(input: ManagedLocalUserCreateInput): Promise<User | null> {
    const actor = this.#users.get(input.actorUserId);
    assertCanCreateManagedUser(actor?.role, input.role);
    const normalizedEmail = input.email.trim().toLowerCase();
    if ([...this.#users.values()].some((user) => user.email === normalizedEmail)) return null;
    const user: User = {
      id: randomUUID(),
      email: normalizedEmail,
      role: input.role,
      createdAt: new Date().toISOString(),
      appInitializedAt: null,
    };
    this.#users.set(user.id, user);
    this.#identities.set(identityKey("local", normalizedEmail), user.id);
    this.#localPasswordHashes.set(user.id, input.passwordHash);
    await this.recordAudit(actor.id, "user.create", "user", user.id, {
      actorRole: actor.role,
      email: user.email,
      role: user.role,
    });
    return clone(user);
  }

  async getLocalPasswordHash(userId: string): Promise<string | null> {
    return this.#localPasswordHashes.get(userId) ?? null;
  }

  async getAccountAuthState(userId: string): Promise<AccountAuthState> {
    if (!this.#users.has(userId)) throw new Error("user_not_found");
    const externalProviders = new Set<string>();
    for (const [identity, identityUserId] of this.#identities) {
      if (identityUserId !== userId) continue;
      const provider = identity.slice(0, identity.indexOf(":"));
      if (provider && provider !== "local") externalProviders.add(provider);
    }
    return {
      hasLocalCredential: this.#localPasswordHashes.has(userId),
      externalProviders: [...externalProviders].sort(),
    };
  }

  async createLocalPasswordHash(userId: string, passwordHash: string): Promise<boolean> {
    return this.#writeLocalPasswordHash(userId, passwordHash, false);
  }

  async replaceLocalPasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<boolean> {
    if (this.#localPasswordHashes.get(userId) !== expectedHash) return false;
    return this.#writeLocalPasswordHash(userId, passwordHash, true);
  }

  /** Test fixture seam; production role writes must use governed operations. */
  protected seedLocalManagementUserForTests(
    email: string,
    passwordHash: string,
    role: "admin" | "super_admin",
  ): User {
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail) throw new Error("management_email_required");
    if ([...this.#users.values()].some((user) => user.email === normalizedEmail)) {
      throw new Error("test_user_already_exists");
    }
    const user: User = {
      id: randomUUID(),
      email: normalizedEmail,
      role,
      createdAt: new Date().toISOString(),
      appInitializedAt: null,
    };
    this.#users.set(user.id, user);
    this.#identities.set(identityKey("local", normalizedEmail), user.id);
    this.#localPasswordHashes.set(user.id, passwordHash);
    return clone(user)!;
  }

  async listUsers(): Promise<User[]> {
    return [...this.#users.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((user) => clone(user)!);
  }

  async changeUserRole(input: UserRoleChangeInput): Promise<User | null> {
    const actor = this.#users.get(input.actorUserId);
    assertCanGovernUserRoles(actor?.role);
    const target = this.#users.get(input.targetUserId);
    if (!target) return null;
    if (actor.id === target.id) throw new UserRoleUpdateError("self_role_change_forbidden");
    if (target.role !== input.expectedRole) throw new UserRoleUpdateError("role_change_conflict");
    if (target.role === input.role) return clone(target)!;
    if (target.role === "super_admin" && input.role !== "super_admin"
      && [...this.#users.values()].filter((user) => user.role === "super_admin").length <= 1) {
      throw new UserRoleUpdateError("last_super_admin_cannot_be_demoted");
    }
    if (input.role !== "user") {
      const hasLocalCredential = this.#localPasswordHashes.has(target.id);
      if (input.passwordHash && hasLocalCredential) throw new UserRoleUpdateError("credential_update_conflict");
      if (!hasLocalCredential && !input.passwordHash) throw new UserRoleUpdateError("local_credentials_required");
      if (!hasLocalCredential && !this.#writeLocalPasswordHash(target.id, input.passwordHash!, false)) {
        throw new UserRoleUpdateError("credential_update_conflict");
      }
    }
    const beforeRole = target.role;
    target.role = input.role;
    await this.recordAudit(actor.id, "user.role.change", "user", target.id, {
      actorRole: actor.role,
      afterRole: target.role,
      beforeRole,
    });
    return clone(target)!;
  }

  async saveSession(tokenHash: string, userId: string, expiresAt: Date, authMethod: AuthMethod): Promise<void> {
    this.#sessions.set(tokenHash, { userId, expiresAt: expiresAt.getTime(), authMethod });
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.#sessions.delete(tokenHash);
  }

  async sessionUser(tokenHash: string): Promise<AuthenticatedUser | null> {
    const session = this.#sessions.get(tokenHash);
    if (!session || session.expiresAt <= Date.now()) {
      this.#sessions.delete(tokenHash);
      return null;
    }
    const user = this.#users.get(session.userId);
    if (!user) return null;
    const authState = await this.getAccountAuthState(user.id);
    return {
      ...clone(user),
      authMethod: session.authMethod,
      passwordSetupRequired: !authState.hasLocalCredential,
      linkedProviders: authState.externalProviders,
    };
  }

  async ensurePersonalTenant(userId: string): Promise<{ tenant: Tenant; membership: TenantMembership }> {
    const user = this.#users.get(userId);
    if (!user) throw new Error("user_not_found");
    const now = new Date().toISOString();
    const id = personalTenantId(user.id);
    let tenant = this.#tenants.get(id);
    if (!tenant) {
      tenant = {
        id,
        kind: "personal",
        name: user.email,
        createdAt: now,
        updatedAt: now,
      };
      this.#tenants.set(id, tenant);
    }
    const key = tenantMembershipKey(id, user.id);
    let membership = this.#tenantMemberships.get(key);
    if (!membership) {
      membership = {
        tenantId: id,
        userId: user.id,
        role: "owner",
        createdAt: now,
        updatedAt: now,
      };
      this.#tenantMemberships.set(key, membership);
    }
    return { tenant: clone(tenant)!, membership: clone(membership)! };
  }

  async listTenantMemberships(userId: string): Promise<Array<{ tenant: Tenant; membership: TenantMembership }>> {
    const memberships = [...this.#tenantMemberships.values()].filter((membership) => membership.userId === userId);
    return memberships.flatMap((membership) => {
      const tenant = this.#tenants.get(membership.tenantId);
      return tenant ? [{ tenant: clone(tenant)!, membership: clone(membership)! }] : [];
    });
  }

  async getWorkspaceTenantBinding(workspaceId: string): Promise<WorkspaceTenantBinding | null> {
    return clone(this.#workspaceTenantBindings.get(workspaceId) ?? null);
  }

  async bindWorkspaceToTenant(workspaceId: string, tenantId: string, ownerId: string): Promise<WorkspaceTenantBinding | null> {
    const container = this.#containers.get(workspaceId);
    const tenant = this.#tenants.get(tenantId);
    const membership = this.#tenantMemberships.get(tenantMembershipKey(tenantId, ownerId));
    if (!container || !tenant || !membership || !isTenantOwnerRole(membership.role) || container.userId !== ownerId) return null;
    const existing = this.#workspaceTenantBindings.get(workspaceId);
    if (existing && (existing.tenantId !== tenantId || existing.ownerId !== ownerId)) return null;
    const binding = existing ?? {
      workspaceId,
      tenantId,
      ownerId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    binding.updatedAt = new Date().toISOString();
    this.#workspaceTenantBindings.set(workspaceId, binding);
    return clone(binding)!;
  }

  #writeLocalPasswordHash(userId: string, passwordHash: string, requireExisting: boolean): boolean {
    const user = this.#users.get(userId);
    if (!user) throw new Error("user_not_found");
    if (this.#localPasswordHashes.has(userId) !== requireExisting) return false;
    this.#localPasswordHashes.set(userId, passwordHash);
    this.#identities.set(identityKey("local", user.email), user.id);
    for (const [tokenHash, session] of this.#sessions) {
      if (session.userId === userId) this.#sessions.delete(tokenHash);
    }
    return true;
  }

  async getContainerForUser(userId: string): Promise<Container | null> {
    const container = [...this.#containers.values()].find((candidate) => (
      candidate.userId === userId
      && this.#workspaceExecutions.get(candidate.id)?.workspace.status === "active"
    ));
    if (!container) return null;
    return projectWorkspaceExecutionToContainer(this.#requireWorkspaceExecutionProjection(container.id));
  }

  async getContainer(id: string): Promise<Container | null> {
    if (!this.#containers.has(id) || this.#workspaceExecutions.get(id)?.workspace.status !== "active") return null;
    return projectWorkspaceExecutionToContainer(this.#requireWorkspaceExecutionProjection(id));
  }

  async listContainers(userId?: string): Promise<Container[]> {
    return [...this.#containers.values()]
      .filter((container) => !userId || container.userId === userId)
      .filter((container) => this.#workspaceExecutions.get(container.id)?.workspace.status === "active")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((container) => projectWorkspaceExecutionToContainer(this.#requireWorkspaceExecutionProjection(container.id)));
  }

  async saveContainer(container: Container): Promise<void> {
    const current = this.#containers.get(container.id);
    const currentProjection = this.#workspaceExecutions.get(container.id);
    if (currentProjection && (
      currentProjection.execution.revision > 1
      || currentProjection.workspace.status !== "active"
    )) {
      throw new WorkspaceExecutionCasRequiredError();
    }
    const stored = {
      ...structuredClone(container),
      lastActivityAt: current
        ? latestTimestamp(current.lastActivityAt, container.lastActivityAt)
        : container.lastActivityAt,
    };
    this.#containers.set(container.id, stored);
    this.#workspaceExecutions.set(container.id, projectContainerToWorkspaceExecution(stored));
  }

  async updateContainer(container: Container): Promise<void> {
    const current = this.#containers.get(container.id);
    const currentProjection = this.#workspaceExecutions.get(container.id);
    if (currentProjection && (
      currentProjection.execution.revision > 1
      || currentProjection.workspace.status !== "active"
    )) {
      throw new WorkspaceExecutionCasRequiredError();
    }
    const stored = {
      ...structuredClone(container),
      lastActivityAt: current
        ? latestTimestamp(current.lastActivityAt, container.lastActivityAt)
        : container.lastActivityAt,
    };
    this.#containers.set(container.id, stored);
    this.#workspaceExecutions.set(container.id, projectContainerToWorkspaceExecution(stored));
  }

  async getWorkspaceExecutionProjection(id: string): Promise<WorkspaceExecutionProjection | null> {
    if (!this.#containers.has(id)) return null;
    return clone(this.#requireWorkspaceExecutionProjection(id));
  }

  async getLiveWorkspaceExecutionForUser(userId: string): Promise<WorkspaceExecutionProjection | null> {
    const projection = [...this.#workspaceExecutions.values()].find((candidate) => (
      candidate.workspace.ownerId === userId && candidate.workspace.status !== "deleted"
    ));
    return clone(projection ?? null);
  }

  async compareAndSaveWorkspaceExecution(
    projection: WorkspaceExecutionProjection,
    expectedRevision: number,
  ): Promise<WorkspaceExecutionProjection | null> {
    const current = this.#workspaceExecutions.get(projection.workspace.id);
    if (!current || current.execution.revision !== expectedRevision) return null;
    assertWorkspaceExecutionTransition(current, projection);
    const updated = clone(projection)!;
    updated.execution.revision = expectedRevision + 1;
    const container = projectWorkspaceExecutionToContainer(updated);
    const stored = this.#containers.get(container.id);
    if (!stored) return null;
    container.lastActivityAt = latestTimestamp(stored.lastActivityAt, container.lastActivityAt);
    updated.execution.lastActivityAt = container.lastActivityAt;
    this.#containers.set(container.id, structuredClone(container));
    this.#workspaceExecutions.set(container.id, updated);
    return clone(updated);
  }

  async countLiveWorkspaceStorageReferences(storageRefId: string, excludingWorkspaceId: string): Promise<number> {
    return [...this.#workspaceExecutions.values()].filter((projection) => (
      projection.workspace.id !== excludingWorkspaceId
      && projection.workspace.status !== "deleted"
      && projection.workspace.storageRefId === storageRefId
    )).length;
  }

  async deleteContainer(id: string): Promise<void> {
    this.#containers.delete(id);
    this.#workspaceExecutions.delete(id);
    this.#workspaceTenantBindings.delete(id);
  }

  #requireWorkspaceExecutionProjection(id: string): WorkspaceExecutionProjection {
    const projection = this.#workspaceExecutions.get(id);
    if (!projection) throw new Error("workspace_execution_projection_missing");
    projectWorkspaceExecutionToContainer(projection);
    return projection;
  }

  async createUpgradeRollout(
    rollout: UpgradeRollout,
    items: UpgradeRolloutItem[],
  ): Promise<UpgradeRolloutDetail> {
    if (rollout.idempotencyKey) {
      const existing = [...this.#upgradeRollouts.values()].find((candidate) => (
        candidate.actorUserId === rollout.actorUserId && candidate.idempotencyKey === rollout.idempotencyKey
      ));
      if (existing) return (await this.getUpgradeRollout(existing.id))!;
    }
    if (this.#upgradeRollouts.has(rollout.id)) throw new Error("upgrade_rollout_exists");
    this.#upgradeRollouts.set(rollout.id, structuredClone(rollout));
    for (const item of items) {
      this.#upgradeRolloutItems.set(upgradeItemKey(item.rolloutId, item.instanceId), structuredClone(item));
    }
    return (await this.getUpgradeRollout(rollout.id))!;
  }

  async findUpgradeRolloutByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<UpgradeRolloutDetail | null> {
    const rollout = [...this.#upgradeRollouts.values()].find((candidate) => (
      candidate.actorUserId === actorUserId && candidate.idempotencyKey === idempotencyKey
    ));
    return rollout ? this.getUpgradeRollout(rollout.id) : null;
  }

  async findLatestUpgradeRecovery(actorUserId: string, instanceId: string): Promise<UpgradeRolloutDetail | null> {
    const rollout = [...this.#upgradeRollouts.values()]
      .filter((candidate) => candidate.actorUserId === actorUserId && candidate.taskKind === "instance_recovery")
      .filter((candidate) => this.#upgradeRolloutItems.get(upgradeItemKey(candidate.id, instanceId))?.recovery === true)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
    return rollout ? this.getUpgradeRollout(rollout.id) : null;
  }

  async getUpgradeRollout(id: string): Promise<UpgradeRolloutDetail | null> {
    const rollout = this.#upgradeRollouts.get(id);
    if (!rollout) return null;
    return {
      rollout: structuredClone(rollout),
      items: [...this.#upgradeRolloutItems.values()]
        .filter((item) => item.rolloutId === id)
        .sort((left, right) => left.position - right.position)
        .map((item) => structuredClone(item)),
    };
  }

  async listUpgradeRollouts(limit = 100): Promise<UpgradeRollout[]> {
    return [...this.#upgradeRollouts.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, clampLimit(limit))
      .map((rollout) => structuredClone(rollout));
  }

  async listActiveUpgradeRolloutTargetReferences(): Promise<UpgradeRolloutTargetReference[]> {
    return [...this.#upgradeRolloutItems.values()]
      .filter(retainsUpgradeRolloutTarget)
      .map((item) => ({
        rolloutId: item.rolloutId,
        instanceId: item.instanceId,
        appId: item.appId,
        sourceAppVersionId: item.sourceAppVersionId,
        sourceImageArtifactId: item.sourceImageArtifactId,
        sourceImageReference: item.sourceImageReference,
        targetAppVersionId: item.targetAppVersionId,
        targetImageArtifactId: item.targetImageArtifactId,
        targetImageReference: item.targetImageReference,
        status: item.status,
      }));
  }

  async listDueUpgradeRolloutItems(at: string, limit: number): Promise<UpgradeRolloutItem[]> {
    return [...this.#upgradeRolloutItems.values()]
      .filter((item) => item.status === "queued"
        || item.status === "waiting_for_idle"
        || item.status === "awaiting_first_start")
      .filter((item) => !item.nextAttemptAt || item.nextAttemptAt <= at)
      .sort((left, right) => {
        const sameInstance = left.instanceId === right.instanceId;
        if (sameInstance) {
          const leftWaiting = left.status === "awaiting_first_start";
          const rightWaiting = right.status === "awaiting_first_start";
          if (leftWaiting !== rightWaiting) return leftWaiting ? 1 : -1;
          return left.createdAt.localeCompare(right.createdAt) || left.rolloutId.localeCompare(right.rolloutId);
        }
        return (left.nextAttemptAt ?? left.createdAt).localeCompare(right.nextAttemptAt ?? right.createdAt);
      })
      .slice(0, clampLimit(limit))
      .map((item) => structuredClone(item));
  }

  async listLegacyFirstStartProofItems(): Promise<UpgradeRolloutItem[]> {
    const imageRolloutIds = new Set(
      [...this.#upgradeRollouts.values()]
        .filter((rollout) => rollout.taskKind === "image_upgrade")
        .map((rollout) => rollout.id),
    );
    return [...this.#upgradeRolloutItems.values()]
      .filter((item) => imageRolloutIds.has(item.rolloutId)
        && item.status === "needs_attention"
        && item.blocker === "candidate_first_start_proof_missing")
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map((item) => structuredClone(item));
  }

  async compareAndSaveUpgradeRolloutItem(
    item: UpgradeRolloutItem,
    expectedRevision: number,
  ): Promise<UpgradeRolloutItem | null> {
    const key = upgradeItemKey(item.rolloutId, item.instanceId);
    const current = this.#upgradeRolloutItems.get(key);
    if (!current || current.revision !== expectedRevision) return null;
    // 目标快照在创建批次后不可变；worker 只能在实例互斥租约内刷新实际
    // 回滚源和最新运行意图，并更新状态机字段。
    const updated: UpgradeRolloutItem = {
      ...structuredClone(current),
      desiredState: item.desiredState,
      sourceAppVersionId: item.sourceAppVersionId,
      sourceImageArtifactId: item.sourceImageArtifactId,
      sourceImageReference: item.sourceImageReference,
      diagnostics: item.diagnostics === undefined ? null : structuredClone(item.diagnostics),
      status: item.status,
      blocker: item.blocker,
      error: item.error,
      forceRequested: item.forceRequested,
      attemptId: item.attemptId,
      attemptCount: item.attemptCount,
      nextAttemptAt: item.nextAttemptAt,
      lastCheckedAt: item.lastCheckedAt,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      updatedAt: item.updatedAt,
      revision: expectedRevision + 1,
    };
    this.#upgradeRolloutItems.set(key, updated);
    return structuredClone(updated);
  }

  async supersedeUpgradeDeferredItemsBefore(
    rolloutId: string,
    instanceId: string,
    at: string,
  ): Promise<string[]> {
    const current = this.#upgradeRolloutItems.get(upgradeItemKey(rolloutId, instanceId));
    if (!current) return [];
    const affectedRolloutIds = new Set<string>();
    for (const [key, candidate] of this.#upgradeRolloutItems) {
      const candidateRollout = this.#upgradeRollouts.get(candidate.rolloutId);
      if (candidate.instanceId !== instanceId
        || !isSupersedableFirstStartItem(candidate, candidateRollout?.taskKind)
        || candidate.createdAt > current.createdAt
        || (candidate.createdAt === current.createdAt && candidate.rolloutId >= current.rolloutId)) continue;
      this.#upgradeRolloutItems.set(key, {
        ...candidate,
        revision: candidate.revision + 1,
        status: "superseded",
        blocker: "superseded_by_newer_deployment",
        error: null,
        attemptId: null,
        nextAttemptAt: null,
        finishedAt: at,
        updatedAt: at,
      });
      affectedRolloutIds.add(candidate.rolloutId);
    }
    return [...affectedRolloutIds];
  }

  async commitUpgradeDeploymentCheckpoint(
    item: UpgradeRolloutItem,
    expectedRevision: number,
    at: string,
    supersedeEarlier = true,
  ): Promise<{ item: UpgradeRolloutItem; affectedRolloutIds: string[] } | null> {
    const key = upgradeItemKey(item.rolloutId, item.instanceId);
    const current = this.#upgradeRolloutItems.get(key);
    if (!current || current.revision !== expectedRevision) return null;
    const updated: UpgradeRolloutItem = {
      ...structuredClone(current),
      desiredState: item.desiredState,
      sourceAppVersionId: item.sourceAppVersionId,
      sourceImageArtifactId: item.sourceImageArtifactId,
      sourceImageReference: item.sourceImageReference,
      diagnostics: item.diagnostics === undefined ? null : structuredClone(item.diagnostics),
      status: item.status,
      blocker: item.blocker,
      error: item.error,
      forceRequested: item.forceRequested,
      attemptId: item.attemptId,
      attemptCount: item.attemptCount,
      nextAttemptAt: item.nextAttemptAt,
      lastCheckedAt: item.lastCheckedAt,
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      updatedAt: at,
      revision: expectedRevision + 1,
    };
    this.#upgradeRolloutItems.set(key, updated);
    const affectedRolloutIds = new Set([item.rolloutId]);
    if (supersedeEarlier && (item.status === "awaiting_first_start" || item.status === "succeeded")) {
      for (const [olderKey, candidate] of this.#upgradeRolloutItems) {
        const candidateRollout = this.#upgradeRollouts.get(candidate.rolloutId);
        if (candidate.instanceId !== item.instanceId
          || !isSupersedableFirstStartItem(candidate, candidateRollout?.taskKind)
          || candidate.createdAt > current.createdAt
          || (candidate.createdAt === current.createdAt && candidate.rolloutId >= current.rolloutId)) continue;
        this.#upgradeRolloutItems.set(olderKey, {
          ...candidate,
          revision: candidate.revision + 1,
          status: "superseded",
          blocker: "superseded_by_newer_deployment",
          error: null,
          attemptId: null,
          nextAttemptAt: null,
          finishedAt: at,
          updatedAt: at,
        });
        affectedRolloutIds.add(candidate.rolloutId);
      }
    }
    return { item: structuredClone(updated), affectedRolloutIds: [...affectedRolloutIds] };
  }

  async compareAndSaveUpgradeRollout(
    rollout: UpgradeRollout,
    expectedRevision: number,
  ): Promise<UpgradeRollout | null> {
    const current = this.#upgradeRollouts.get(rollout.id);
    if (!current || current.revision !== expectedRevision) return null;
    const updated: UpgradeRollout = {
      ...structuredClone(current),
      status: rollout.status,
      completed: rollout.completed,
      succeeded: rollout.succeeded,
      superseded: rollout.superseded ?? 0,
      failed: rollout.failed,
      waiting: rollout.waiting,
      upgrading: rollout.upgrading,
      needsAttention: rollout.needsAttention,
      updatedAt: rollout.updatedAt,
      finishedAt: rollout.finishedAt,
      revision: expectedRevision + 1,
    };
    this.#upgradeRollouts.set(updated.id, updated);
    return structuredClone(updated);
  }

  async recoverInterruptedUpgradeRolloutItems(cutoff: string, recoveredAt: string): Promise<number> {
    let recovered = 0;
    for (const [key, item] of this.#upgradeRolloutItems) {
      if (!["assessing", "draining", "rebuilding", "verifying"].includes(item.status) || item.updatedAt > cutoff) continue;
      const candidateNeedsReconciliation = (item.status === "rebuilding" || item.status === "verifying")
        && item.attemptId !== null;
      this.#upgradeRolloutItems.set(key, {
        ...item,
        revision: item.revision + 1,
        status: candidateNeedsReconciliation ? "awaiting_first_start" : "queued",
        blocker: candidateNeedsReconciliation ? "candidate_recovery_pending" : "portal_restarted",
        error: null,
        attemptId: candidateNeedsReconciliation ? item.attemptId : null,
        nextAttemptAt: recoveredAt,
        finishedAt: null,
        updatedAt: recoveredAt,
      });
      recovered += 1;
    }
    for (const [instanceId, drain] of this.#instanceUpgradeDrains) {
      const item = this.#upgradeRolloutItems.get(upgradeItemKey(drain.rolloutId, instanceId));
      const ownsActiveTransition = item
        && ["assessing", "draining", "rebuilding", "verifying"].includes(item.status);
      if (drain.expiresAt <= recoveredAt || !ownsActiveTransition) {
        this.#instanceUpgradeDrains.delete(instanceId);
      }
    }
    return recovered;
  }

  async tryOpenInstanceActivityLease(lease: InstanceActivityLease, at: string): Promise<boolean> {
    return this.#withInstanceActivityLock(lease.instanceId, () => {
      if (this.#workspaceExecutions.get(lease.instanceId)?.workspace.status !== "active") return false;
      if (this.#isInstanceDraining(lease.instanceId, at)) return false;
      this.#instanceActivityLeases.set(lease.id, structuredClone(lease));
      this.#touchContainerAt(lease.instanceId, lease.openedAt);
      return true;
    });
  }

  async renewInstanceActivityLease(lease: InstanceActivityLease, at: string): Promise<boolean> {
    return this.#withInstanceActivityLock(lease.instanceId, () => {
      if (
        this.#workspaceExecutions.get(lease.instanceId)?.workspace.status !== "active"
        || !this.#instanceActivityLeases.has(lease.id)
        || this.#isInstanceDraining(lease.instanceId, at)
      ) {
        return false;
      }
      this.#instanceActivityLeases.set(lease.id, structuredClone(lease));
      this.#touchContainerAt(lease.instanceId, lease.lastActivityAt);
      return true;
    });
  }

  async deleteInstanceActivityLease(id: string): Promise<void> {
    const lease = this.#instanceActivityLeases.get(id);
    if (!lease) return;
    await this.#withInstanceActivityLock(lease.instanceId, () => {
      this.#instanceActivityLeases.delete(id);
    });
  }

  async closeInstanceActivityLease(id: string, instanceId: string, closedAt: string): Promise<void> {
    await this.#withInstanceActivityLock(instanceId, () => {
      const lease = this.#instanceActivityLeases.get(id);
      if (lease?.instanceId === instanceId) this.#instanceActivityLeases.delete(id);
      this.#touchContainerAt(instanceId, closedAt);
    });
  }

  async listActiveInstanceActivityLeases(
    instanceId: string,
    heartbeatCutoff: string,
  ): Promise<InstanceActivityLease[]> {
    return this.#withInstanceActivityLock(instanceId, () => [...this.#instanceActivityLeases.values()]
      .filter((lease) => lease.instanceId === instanceId && lease.heartbeatAt >= heartbeatCutoff)
      .sort((left, right) => left.openedAt.localeCompare(right.openedAt))
      .map((lease) => structuredClone(lease)));
  }

  async beginInstanceDraining(request: InstanceDrainRequest): Promise<boolean> {
    const { instanceId, rolloutId, attemptId, at, expiresAt, heartbeatCutoff, websocketActivityCutoff, mode } = request;
    return this.#withInstanceActivityLock(instanceId, () => {
      const existingDrain = this.#instanceUpgradeDrains.get(instanceId);
      if (existingDrain) {
        if (
          existingDrain.expiresAt > at
          && (existingDrain.rolloutId !== rolloutId || existingDrain.attemptId !== attemptId)
        ) return false;
        if (existingDrain.expiresAt <= at) this.#instanceUpgradeDrains.delete(instanceId);
      }
      const activeLease = mode === "graceful" && [...this.#instanceActivityLeases.values()].some((lease) => (
        lease.instanceId === instanceId
        && lease.heartbeatAt >= heartbeatCutoff
        && (lease.kind === "http" || lease.lastActivityAt >= websocketActivityCutoff)
      ));
      if (activeLease) return false;
      this.#instanceUpgradeDrains.set(instanceId, { rolloutId, attemptId, expiresAt });
      return true;
    });
  }

  async clearInstanceDraining(instanceId: string, rolloutId: string, attemptId: string): Promise<void> {
    await this.#withInstanceActivityLock(instanceId, () => {
      const drain = this.#instanceUpgradeDrains.get(instanceId);
      if (drain?.rolloutId === rolloutId && drain.attemptId === attemptId) {
        this.#instanceUpgradeDrains.delete(instanceId);
      }
    });
  }

  async isInstanceDraining(instanceId: string, at: string): Promise<boolean> {
    return this.#withInstanceActivityLock(instanceId, () => this.#isInstanceDraining(instanceId, at));
  }

  #isInstanceDraining(instanceId: string, at: string): boolean {
    const drain = this.#instanceUpgradeDrains.get(instanceId);
    if (!drain) return false;
    if (drain.expiresAt > at) return true;
    this.#instanceUpgradeDrains.delete(instanceId);
    return false;
  }

  #touchContainerAt(instanceId: string, at: string): void {
    const container = this.#containers.get(instanceId);
    if (!container) return;
    const lastActivityAt = latestTimestamp(container.lastActivityAt, at);
    container.lastActivityAt = lastActivityAt;
    const projection = this.#workspaceExecutions.get(instanceId);
    if (projection) projection.execution.lastActivityAt = lastActivityAt;
  }

  async #withInstanceActivityLock<T>(instanceId: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#instanceActivityLocks.get(instanceId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#instanceActivityLocks.set(instanceId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#instanceActivityLocks.get(instanceId) === current) {
        this.#instanceActivityLocks.delete(instanceId);
      }
    }
  }
}

function identityKey(provider: AuthProviderId | "local", subject: string): string {
  return `${provider}:${subject.trim()}`;
}

function normalizeAuthProvider(provider: AuthProviderId | "local"): AuthProviderId | "local" {
  const normalized = provider.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error("default_auth_provider_invalid");
  }
  return normalized;
}

function tenantMembershipKey(tenantId: string, userId: string): string {
  return `${tenantId}:${userId}`;
}

function isTenantOwnerRole(role: TenantMembershipRole): boolean {
  return role === "owner" || role === "admin";
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function upgradeItemKey(rolloutId: string, instanceId: string): string {
  return `${rolloutId}:${instanceId}`;
}

function retainsUpgradeRolloutTarget(item: UpgradeRolloutItem): boolean {
  return item.status !== "succeeded" && item.status !== "superseded"
    && item.status !== "cancelled";
}

function isSupersedableFirstStartItem(
  item: UpgradeRolloutItem,
  taskKind?: UpgradeRollout["taskKind"],
): boolean {
  return item.status === "awaiting_first_start"
    || (taskKind === "image_upgrade"
      && item.status === "needs_attention"
      && item.blocker === "candidate_first_start_proof_missing");
}

function latestTimestamp(left: string, right: string): string {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (!Number.isFinite(leftTime)) return right;
  if (!Number.isFinite(rightTime)) return left;
  return rightTime > leftTime ? right : left;
}

function initialConfigRevision(key: string): ConfigRevision {
  return {
    key,
    revision: 0,
    updatedBy: "system",
    updatedAt: new Date(0).toISOString(),
    effect: "immediate",
    effectiveAt: new Date(0).toISOString(),
  };
}

function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 60;
}

function clampOffset(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
