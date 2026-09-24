import type { ProvisioningPolicy, ProvisioningPolicyDefaults } from "../instance-policy.js";
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
  WorkspaceTenantBinding,
} from "../models.js";
import type { AuthProviderId } from "../auth/types.js";
import type { AuditEvent, AuditEventFilter, HealthCheck, RuntimeSample } from "../monitoring-types.js";
import type { AdminOperation, AdminOperationFilter } from "../admin-operations.js";
import type { InstanceActivityLease, InstanceDrainRequest } from "../instance-upgrade-activity.js";
import type { MaintenanceLeaseOptions } from "../maintenance-lease.js";
import type {
  UpgradeRollout,
  UpgradeRolloutDetail,
  UpgradeRolloutItem,
  UpgradeRolloutTargetReference,
} from "../upgrade-rollouts.js";
import type { WorkspaceExecutionProjection } from "../workspace-execution.js";

export interface Persistence {
  /**
   * 初始化数据库结构，并可选地写入由已注册 App 插件提供的策略定义。
   * 未传入参数时保留旧版本的兼容引导；传入空列表表示通用 Core 不应猜测
   * 任何产品策略，但绝不删除数据库中已经存在的历史策略。
   */
  initialize(options?: PersistenceInitializeOptions): Promise<void>;
  /** 释放数据库连接；内存适配器可实现为空操作。 */
  close?(): Promise<void>;
  /** 验证数据服务可用，不执行迁移或业务写入。 */
  checkReady?(): Promise<void>;
  listApps(): Promise<AppDefinition[]>;
  getApp(appId: string): Promise<AppDefinition | null>;
  createApp(app: AppDefinition): Promise<AppDefinition | null>;
  updateApp(app: AppDefinition): Promise<AppDefinition | null>;
  listAppVersions(appId: string): Promise<AppVersion[]>;
  getAppVersion(id: string): Promise<AppVersion | null>;
  saveAppVersion(version: AppVersion): Promise<AppVersion | null>;
  activateAppVersion(
    appId: string,
    versionId: string,
    expectedCurrentVersionId?: string | null,
  ): Promise<AppVersion | null>;
  listBuildStrategies(): Promise<BuildStrategy[]>;
  getBuildStrategy(id: string): Promise<BuildStrategy | null>;
  saveBuildStrategy(strategy: BuildStrategy): Promise<BuildStrategy>;
  listBuildPackages(strategyId?: string, key?: string, limit?: number): Promise<BuildPackage[]>;
  getBuildPackage(id: string): Promise<BuildPackage | null>;
  createBuildPackage(pkg: BuildPackage): Promise<BuildPackage | null>;
  deleteBuildPackageIfUnreferenced(id: string): Promise<BuildPackage | null>;
  listImageBuilds(strategyId?: string, limit?: number): Promise<ImageBuild[]>;
  getImageBuild(id: string): Promise<ImageBuild | null>;
  createImageBuild(build: ImageBuild): Promise<ImageBuild | null>;
  updateImageBuild(build: ImageBuild, expectedStatus: ImageBuildStatus): Promise<ImageBuild | null>;
  recoverInterruptedImageBuilds(finishedAt: string): Promise<number>;
  completeImageBuild(
    build: ImageBuild,
    artifact: ImageArtifact,
    expectedStatus: ImageBuildStatus,
  ): Promise<{ build: ImageBuild; artifact: ImageArtifact } | null>;
  getImageArtifact(id: string): Promise<ImageArtifact | null>;
  getImageArtifactForBuild(buildId: string): Promise<ImageArtifact | null>;
  listImageArtifacts(limit?: number): Promise<ImageArtifact[]>;
  deleteImageArtifactIfUnreferenced(id: string): Promise<ImageArtifact | null>;
  bindAppVersionArtifact(appId: string, versionId: string, artifactId: string): Promise<AppVersion | null>;
  getProvisioningPolicy(): Promise<ProvisioningPolicy>;
  saveProvisioningPolicy(
    policy: ProvisioningPolicy,
    revision?: ConfigRevisionInput,
  ): Promise<ProvisioningPolicy>;
  getConfigRevision(key: string): Promise<ConfigRevision | null>;
  saveConfigRevision(key: string, revision?: ConfigRevisionInput): Promise<ConfigRevision>;
  listConfigRevisions(key: string, limit?: number): Promise<ConfigRevisionSnapshot[]>;
  getConfigRevisionSnapshot(key: string, revision: number): Promise<ConfigRevisionSnapshot | null>;
  touchContainer(id: string, at?: Date): Promise<void>;
  markUserAppInitialized(id: string): Promise<void>;
  getUser(id: string): Promise<User | null>;
  withInstanceCapacityLock<T>(operation: () => Promise<T>): Promise<T>;
  withReleaseActivationLock<T>(operation: () => Promise<T>): Promise<T>;
  withMaintenanceLease<T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options?: MaintenanceLeaseOptions,
  ): Promise<T | null>;
  upsertForwardingPolicy(
    policy: Omit<ForwardingPolicy, "updatedAt">,
    revision?: ConfigRevisionInput,
  ): Promise<ForwardingPolicy>;
  listForwardingPolicies(): Promise<ForwardingPolicy[]>;
  recordAudit(
    actorUserId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata?: unknown,
  ): Promise<void>;
  findUserByEmail(email: string): Promise<User | null>;
  findUserByIdentity(provider: AuthProviderId | "local", subject: string): Promise<User | null>;
  findOrCreateUser(email: string, preferredId?: string, provider?: AuthProviderId | "local"): Promise<User>;
  createLocalUser(email: string, passwordHash: string): Promise<User | null>;
  createManagedLocalUser(input: ManagedLocalUserCreateInput): Promise<User | null>;
  getLocalPasswordHash(userId: string): Promise<string | null>;
  getAccountAuthState(userId: string): Promise<AccountAuthState>;
  createLocalPasswordHash(userId: string, passwordHash: string): Promise<boolean>;
  replaceLocalPasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<boolean>;
  listUsers(): Promise<User[]>;
  changeUserRole(input: UserRoleChangeInput): Promise<User | null>;
  saveSession(tokenHash: string, userId: string, expiresAt: Date, authMethod: AuthMethod): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  sessionUser(tokenHash: string): Promise<AuthenticatedUser | null>;
  getContainerForUser(userId: string): Promise<Container | null>;
  getContainer(id: string): Promise<Container | null>;
  listContainers(userId?: string): Promise<Container[]>;
  saveContainer(container: Container): Promise<void>;
  updateContainer(container: Container): Promise<void>;
  getWorkspaceExecutionProjection(id: string): Promise<WorkspaceExecutionProjection | null>;
  getLiveWorkspaceExecutionForUser(userId: string): Promise<WorkspaceExecutionProjection | null>;
  compareAndSaveWorkspaceExecution(
    projection: WorkspaceExecutionProjection,
    expectedRevision: number,
  ): Promise<WorkspaceExecutionProjection | null>;
  countLiveWorkspaceStorageReferences(storageRefId: string, excludingWorkspaceId: string): Promise<number>;
  deleteContainer(id: string): Promise<void>;
  /** Monitoring persistence is optional for lightweight local adapters. */
  recordRuntimeSample?(sample: RuntimeSample): Promise<void>;
  listRuntimeSamples?(instanceId: string, limit?: number): Promise<RuntimeSample[]>;
  listLatestRuntimeSamples?(instanceIds: readonly string[]): Promise<RuntimeSample[]>;
  recordHealthCheck?(check: HealthCheck): Promise<void>;
  listHealthChecks?(target?: string, limit?: number): Promise<HealthCheck[]>;
  listAuditEvents?(filter?: AuditEventFilter): Promise<AuditEvent[]>;
  saveOperation(operation: AdminOperation): Promise<void>;
  createOperation(operation: AdminOperation): Promise<{ operation: AdminOperation; created: boolean }>;
  compareAndSaveOperation(
    operation: AdminOperation,
    expectedRevision: number,
  ): Promise<AdminOperation | null>;
  recoverStaleOperations(cutoff: string, finishedAt: string): Promise<string[]>;
  getOperation(id: string): Promise<AdminOperation | null>;
  listOperations(filter?: AdminOperationFilter): Promise<AdminOperation[]>;
  findOperationByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<AdminOperation | null>;
  pruneFinishedOperations?(retentionMs?: number): Promise<number>;
  createUpgradeRollout(rollout: UpgradeRollout, items: UpgradeRolloutItem[]): Promise<UpgradeRolloutDetail>;
  findUpgradeRolloutByIdempotencyKey(
    actorUserId: string,
    idempotencyKey: string,
  ): Promise<UpgradeRolloutDetail | null>;
  findLatestUpgradeRecovery(actorUserId: string, instanceId: string): Promise<UpgradeRolloutDetail | null>;
  getUpgradeRollout(id: string): Promise<UpgradeRolloutDetail | null>;
  listUpgradeRollouts(limit?: number): Promise<UpgradeRollout[]>;
  listActiveUpgradeRolloutTargetReferences(): Promise<UpgradeRolloutTargetReference[]>;
  listDueUpgradeRolloutItems(at: string, limit: number): Promise<UpgradeRolloutItem[]>;
  /** Historical image-upgrade items whose first-start proof was lost during a Portal upgrade. */
  listLegacyFirstStartProofItems?(): Promise<UpgradeRolloutItem[]>;
  compareAndSaveUpgradeRolloutItem(
    item: UpgradeRolloutItem,
    expectedRevision: number,
  ): Promise<UpgradeRolloutItem | null>;
  supersedeUpgradeDeferredItemsBefore(rolloutId: string, instanceId: string, at: string): Promise<string[]>;
  commitUpgradeDeploymentCheckpoint(
    item: UpgradeRolloutItem,
    expectedRevision: number,
    at: string,
    supersedeEarlier?: boolean,
  ): Promise<{ item: UpgradeRolloutItem; affectedRolloutIds: string[] } | null>;
  compareAndSaveUpgradeRollout(
    rollout: UpgradeRollout,
    expectedRevision: number,
  ): Promise<UpgradeRollout | null>;
  recoverInterruptedUpgradeRolloutItems(cutoff: string, recoveredAt: string): Promise<number>;
  tryOpenInstanceActivityLease(lease: InstanceActivityLease, at: string): Promise<boolean>;
  renewInstanceActivityLease(lease: InstanceActivityLease, at: string): Promise<boolean>;
  deleteInstanceActivityLease(id: string): Promise<void>;
  closeInstanceActivityLease(id: string, instanceId: string, closedAt: string): Promise<void>;
  listActiveInstanceActivityLeases(
    instanceId: string,
    heartbeatCutoff: string,
  ): Promise<InstanceActivityLease[]>;
  beginInstanceDraining(request: InstanceDrainRequest): Promise<boolean>;
  clearInstanceDraining(instanceId: string, rolloutId: string, attemptId: string): Promise<void>;
  isInstanceDraining(instanceId: string, at: string): Promise<boolean>;
  /** M5 additive tenant projection; legacy user/container methods remain authoritative during migration. */
  ensurePersonalTenant(userId: string): Promise<{ tenant: Tenant; membership: TenantMembership }>;
  listTenantMemberships(userId: string): Promise<Array<{ tenant: Tenant; membership: TenantMembership }>>;
  getWorkspaceTenantBinding(workspaceId: string): Promise<WorkspaceTenantBinding | null>;
  bindWorkspaceToTenant(
    workspaceId: string,
    tenantId: string,
    ownerId: string,
  ): Promise<WorkspaceTenantBinding | null>;
}

export interface PersistenceInitializeOptions {
  readonly legacyPackageColumns?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly strategyDefinitions?: readonly BuildStrategy[];
  /** 仅在持久化策略行不存在时应用的 Adapter 默认值。 */
  readonly provisioningPolicyDefaults?: ProvisioningPolicyDefaults;
  /** 显式选择旧的无参数迁移兼容行为；仅保留 API 兼容，不提供产品默认值。 */
  readonly legacyCompatibility?: boolean;
  /** @deprecated 使用 compatibilityDefaults.authProvider。 */
  readonly defaultAuthProvider?: AuthProviderId | "local";
  /** 由组合根显式提供的历史默认值；Core 不从 App 名称推断。 */
  readonly compatibilityDefaults?: PersistenceCompatibilityDefaults;
}

export interface PersistenceCompatibilityDefaults {
  readonly authProvider?: AuthProviderId | "local";
  readonly appId?: string;
}
