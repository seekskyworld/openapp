/**
 * OpenApp 通用 Store 合同。
 *
 * 这里仅描述领域层需要的最小持久化能力，不创建全局实例，也不携带任何
 * 产品默认值；外部组合通过同一合同注入持久化实现。
 */
import type { ProvisioningPolicy } from "./instance-policy.js";
import type {
  AccountAuthState,
  AppDefinition,
  AppVersion,
  AuthMethod,
  AuthenticatedUser,
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
  Tenant,
  TenantMembership,
  User,
  UserRoleChangeInput,
  WorkspaceTenantBinding,
} from "./models.js";
import type { AuthProviderId } from "./auth/types.js";
import type { AuditEvent, AuditEventFilter, HealthCheck, RuntimeSample } from "./monitoring-types.js";
import type { AdminOperation, AdminOperationFilter } from "./admin-operations.js";
import type { InstanceActivityStore, InstanceUpgradeAdmissionStore } from "./instance-upgrade-activity.js";
import type { MaintenanceLeaseOptions } from "./maintenance-lease.js";
import type { Persistence, PersistenceInitializeOptions } from "./persistence/contracts.js";
import type { UpgradeRolloutStore } from "./upgrade-rollouts.js";
import type { WorkspaceExecutionProjection } from "./workspace-execution.js";

export interface IdentityStore {
  findUserByEmail(email: string): Promise<User | null>;
  findUserByIdentity(provider: AuthProviderId | "local", subject: string): Promise<User | null>;
  findOrCreateUser(email: string, subject?: string, provider?: AuthProviderId | "local"): Promise<User>;
  createLocalUser(email: string, passwordHash: string): Promise<User | null>;
  getLocalPasswordHash(userId: string): Promise<string | null>;
  getAccountAuthState(userId: string): Promise<AccountAuthState>;
  createLocalPasswordHash(userId: string, passwordHash: string): Promise<boolean>;
  replaceLocalPasswordHash(userId: string, expectedHash: string, passwordHash: string): Promise<boolean>;
  saveSession(hash: string, userId: string, expiresAt: Date, authMethod: AuthMethod): Promise<void>;
  deleteSession(hash: string): Promise<void>;
  sessionUser(hash: string): Promise<AuthenticatedUser | null>;
}

export interface TenantStore {
  ensurePersonalTenant(userId: string): Promise<{ tenant: Tenant; membership: TenantMembership }>;
  listTenantMemberships(userId: string): Promise<Array<{ tenant: Tenant; membership: TenantMembership }>>;
  getWorkspaceTenantBinding(workspaceId: string): Promise<WorkspaceTenantBinding | null>;
  bindWorkspaceToTenant(
    workspaceId: string,
    tenantId: string,
    ownerId: string,
  ): Promise<WorkspaceTenantBinding | null>;
}

export interface InstanceStore {
  getProvisioningPolicy(): Promise<ProvisioningPolicy>;
  getUser(id: string): Promise<User | null>;
  getContainer(id: string): Promise<Container | null>;
  getContainerForUser(userId: string): Promise<Container | null>;
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
  touchContainer(id: string, at?: Date): Promise<void>;
  deleteContainer(id: string): Promise<void>;
  markUserAppInitialized(id: string): Promise<void>;
  withCapacityLock<T>(operation: () => Promise<T>): Promise<T>;
}

export interface CatalogStore {
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
}

/** Persistence seam for strategy-driven image builds and release bindings. */
export interface BuildStore {
  getApp(appId: string): Promise<AppDefinition | null>;
  getRelease(id: string): Promise<AppVersion | null>;
  listStrategies(): Promise<BuildStrategy[]>;
  getStrategy(id: string): Promise<BuildStrategy | null>;
  saveStrategy(strategy: BuildStrategy): Promise<BuildStrategy>;
  listPackages(strategyId?: string, key?: string, limit?: number): Promise<BuildPackage[]>;
  getPackage(id: string): Promise<BuildPackage | null>;
  createPackage(pkg: BuildPackage): Promise<BuildPackage | null>;
  deleteBuildPackageIfUnreferenced(id: string): Promise<BuildPackage | null>;
  listBuilds(strategyId?: string, limit?: number): Promise<ImageBuild[]>;
  getBuild(id: string): Promise<ImageBuild | null>;
  createBuild(build: ImageBuild): Promise<ImageBuild | null>;
  updateBuild(build: ImageBuild, expectedStatus: ImageBuildStatus): Promise<ImageBuild | null>;
  recoverInterruptedBuilds(finishedAt: string): Promise<number>;
  completeBuild(
    build: ImageBuild,
    artifact: ImageArtifact,
    expectedStatus: ImageBuildStatus,
  ): Promise<{ build: ImageBuild; artifact: ImageArtifact } | null>;
  getArtifact(id: string): Promise<ImageArtifact | null>;
  getArtifactForBuild(buildId: string): Promise<ImageArtifact | null>;
  listArtifacts(limit?: number): Promise<ImageArtifact[]>;
  deleteImageArtifactIfUnreferenced(id: string): Promise<ImageArtifact | null>;
  bindRelease(appId: string, versionId: string, artifactId: string): Promise<AppVersion | null>;
}

export interface AdminStore {
  listUsers(): Promise<User[]>;
  createManagedLocalUser(input: ManagedLocalUserCreateInput): Promise<User | null>;
  changeUserRole(input: UserRoleChangeInput): Promise<User | null>;
  listContainers(userId?: string): Promise<Container[]>;
  getContainer(id: string): Promise<Container | null>;
  getProvisioningPolicy(): Promise<ProvisioningPolicy>;
  saveProvisioningPolicy(
    policy: ProvisioningPolicy,
    revision?: ConfigRevisionInput,
  ): Promise<ProvisioningPolicy>;
  getConfigRevision(key: string): Promise<ConfigRevision | null>;
  saveConfigRevision(key: string, revision?: ConfigRevisionInput): Promise<ConfigRevision>;
  listConfigRevisions(key: string, limit?: number): Promise<ConfigRevisionSnapshot[]>;
  getConfigRevisionSnapshot(key: string, revision: number): Promise<ConfigRevisionSnapshot | null>;
  listForwardingPolicies(): Promise<ForwardingPolicy[]>;
  upsertForwardingPolicy(
    policy: Omit<ForwardingPolicy, "updatedAt">,
    revision?: ConfigRevisionInput,
  ): Promise<ForwardingPolicy>;
  touchContainer(id: string, at?: Date): Promise<void>;
  recordAudit(
    actorUserId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    metadata?: unknown,
  ): Promise<void>;
  withReleaseActivationLock<T>(operation: () => Promise<T>): Promise<T>;
  withMaintenanceLease<T>(
    name: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options?: MaintenanceLeaseOptions,
  ): Promise<T | null>;
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
  withRetryLock<T>(id: string, operation: () => Promise<T>): Promise<T | null>;
  getOperation(id: string): Promise<AdminOperation | null>;
  listOperations(filter?: AdminOperationFilter): Promise<AdminOperation[]>;
  findOperationByIdempotencyKey(actorUserId: string, idempotencyKey: string): Promise<AdminOperation | null>;
  pruneFinishedOperations?(retentionMs?: number): Promise<number>;
}

export interface PortalStores {
  initialize(options?: PersistenceInitializeOptions): Promise<void>;
  checkReady?(): Promise<void>;
  close?(): Promise<void>;
  identity: IdentityStore;
  tenants: TenantStore;
  instances: InstanceStore;
  catalog: CatalogStore;
  builds: BuildStore;
  admin: AdminStore;
  upgrades: UpgradeRolloutStore;
  activity: InstanceActivityStore & InstanceUpgradeAdmissionStore;
}

/** 用于需要同时接受不同持久化实现的通用组合边界。 */
export type GenericStoreFactory = (adapter: Persistence) => PortalStores;
