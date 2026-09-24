/**
 * 通用 Portal Store 组合工厂。
 *
 * 该模块只接受显式 Persistence，不读取全局单例或具体产品兼容实现。
 */
import type {
  AuthMethod,
  AccountAuthState,
  AppDefinition,
  AppVersion,
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
  User,
  UserRoleChangeInput,
  Tenant,
  TenantMembership,
  WorkspaceTenantBinding,
} from "./models.js";
import type { AuthProviderId } from "./auth/types.js";
import type { AuditEvent, AuditEventFilter, HealthCheck, RuntimeSample } from "./monitoring-types.js";
import type { AdminOperation, AdminOperationFilter } from "./admin-operations.js";
import type { UpgradeRolloutStore } from "./upgrade-rollouts.js";
import type { InstanceActivityStore, InstanceUpgradeAdmissionStore } from "./instance-upgrade-activity.js";
import type { Persistence, PersistenceInitializeOptions } from "./persistence/contracts.js";
import type { MaintenanceLeaseOptions } from "./maintenance-lease.js";
import type { WorkspaceExecutionProjection } from "./workspace-execution.js";
import type {
  AdminStore,
  BuildStore,
  CatalogStore,
  IdentityStore,
  InstanceStore,
  PortalStores,
  TenantStore,
} from "./stores-contracts.js";

/**
 * 以显式 Persistence 组装各领域 Store。所有方法都是轻量委托，生命周期和
 * 默认值由调用方的 Persistence/Adapter 决定，避免 Core 猜测业务产品。
 */
export function createGenericPortalStores(adapter: Persistence): PortalStores {
  const identity: IdentityStore = {
    findUserByEmail: (email) => adapter.findUserByEmail(email),
    findUserByIdentity: (provider, subject) => adapter.findUserByIdentity(provider, subject),
    findOrCreateUser: (email, subject, provider) => adapter.findOrCreateUser(email, subject, provider),
    createLocalUser: (email, passwordHash) => adapter.createLocalUser(email, passwordHash),
    getLocalPasswordHash: (userId) => adapter.getLocalPasswordHash(userId),
    getAccountAuthState: (userId) => adapter.getAccountAuthState(userId),
    createLocalPasswordHash: (userId, passwordHash) => adapter.createLocalPasswordHash(userId, passwordHash),
    replaceLocalPasswordHash: (userId, expectedHash, passwordHash) =>
      adapter.replaceLocalPasswordHash(userId, expectedHash, passwordHash),
    saveSession: (hash, userId, expiresAt, authMethod) =>
      adapter.saveSession(hash, userId, expiresAt, authMethod),
    deleteSession: (hash) => adapter.deleteSession(hash),
    sessionUser: (hash) => adapter.sessionUser(hash),
  };

  const tenants: TenantStore = {
    ensurePersonalTenant: (userId) => adapter.ensurePersonalTenant(userId),
    listTenantMemberships: (userId) => adapter.listTenantMemberships(userId),
    getWorkspaceTenantBinding: (workspaceId) => adapter.getWorkspaceTenantBinding(workspaceId),
    bindWorkspaceToTenant: (workspaceId, tenantId, ownerId) =>
      adapter.bindWorkspaceToTenant(workspaceId, tenantId, ownerId),
  };

  const instances: InstanceStore = {
    getProvisioningPolicy: () => adapter.getProvisioningPolicy(),
    getUser: (id) => adapter.getUser(id),
    getContainer: (id) => adapter.getContainer(id),
    getContainerForUser: (userId) => adapter.getContainerForUser(userId),
    listContainers: (userId) => adapter.listContainers(userId),
    saveContainer: (container) => adapter.saveContainer(container),
    updateContainer: (container) => adapter.updateContainer(container),
    getWorkspaceExecutionProjection: (id) => adapter.getWorkspaceExecutionProjection(id),
    getLiveWorkspaceExecutionForUser: (userId) => adapter.getLiveWorkspaceExecutionForUser(userId),
    compareAndSaveWorkspaceExecution: (projection, expectedRevision) =>
      adapter.compareAndSaveWorkspaceExecution(projection, expectedRevision),
    countLiveWorkspaceStorageReferences: (storageRefId, excludingWorkspaceId) =>
      adapter.countLiveWorkspaceStorageReferences(storageRefId, excludingWorkspaceId),
    touchContainer: (id, at) => adapter.touchContainer(id, at),
    deleteContainer: (id) => adapter.deleteContainer(id),
    markUserAppInitialized: (id) => adapter.markUserAppInitialized(id),
    withCapacityLock: (operation) => adapter.withInstanceCapacityLock(operation),
  };

  const catalog: CatalogStore = {
    listApps: () => adapter.listApps(),
    getApp: (appId) => adapter.getApp(appId),
    createApp: (app) => adapter.createApp(app),
    updateApp: (app) => adapter.updateApp(app),
    listAppVersions: (appId) => adapter.listAppVersions(appId),
    getAppVersion: (id) => adapter.getAppVersion(id),
    saveAppVersion: (version) => adapter.saveAppVersion(version),
    activateAppVersion: (appId, versionId, expectedCurrentVersionId) =>
      adapter.activateAppVersion(appId, versionId, expectedCurrentVersionId),
  };

  const builds: BuildStore = {
    getApp: (appId) => adapter.getApp(appId),
    getRelease: (id) => adapter.getAppVersion(id),
    listStrategies: () => adapter.listBuildStrategies(),
    getStrategy: (id) => adapter.getBuildStrategy(id),
    saveStrategy: (strategy) => adapter.saveBuildStrategy(strategy),
    listPackages: (strategyId, key, limit) => adapter.listBuildPackages(strategyId, key, limit),
    getPackage: (id) => adapter.getBuildPackage(id),
    createPackage: (pkg) => adapter.createBuildPackage(pkg),
    deleteBuildPackageIfUnreferenced: (id) => adapter.deleteBuildPackageIfUnreferenced(id),
    listBuilds: (strategyId, limit) => adapter.listImageBuilds(strategyId, limit),
    getBuild: (id) => adapter.getImageBuild(id),
    createBuild: (build) => adapter.createImageBuild(build),
    updateBuild: (build, expectedStatus) => adapter.updateImageBuild(build, expectedStatus),
    recoverInterruptedBuilds: (finishedAt) => adapter.recoverInterruptedImageBuilds(finishedAt),
    completeBuild: (build, artifact, expectedStatus) =>
      adapter.completeImageBuild(build, artifact, expectedStatus),
    getArtifact: (id) => adapter.getImageArtifact(id),
    getArtifactForBuild: (buildId) => adapter.getImageArtifactForBuild(buildId),
    listArtifacts: (limit) => adapter.listImageArtifacts(limit),
    deleteImageArtifactIfUnreferenced: (id) => adapter.deleteImageArtifactIfUnreferenced(id),
    bindRelease: (appId, versionId, artifactId) =>
      adapter.bindAppVersionArtifact(appId, versionId, artifactId),
  };

  const admin: AdminStore = {
    listUsers: () => adapter.listUsers(),
    createManagedLocalUser: (input: ManagedLocalUserCreateInput) => adapter.createManagedLocalUser(input),
    changeUserRole: (input: UserRoleChangeInput) => adapter.changeUserRole(input),
    listContainers: (userId) => adapter.listContainers(userId),
    getContainer: (id) => adapter.getContainer(id),
    getProvisioningPolicy: () => adapter.getProvisioningPolicy(),
    saveProvisioningPolicy: (policy, revision) => adapter.saveProvisioningPolicy(policy, revision),
    getConfigRevision: (key) => adapter.getConfigRevision(key),
    saveConfigRevision: (key, revision) => adapter.saveConfigRevision(key, revision),
    listConfigRevisions: (key, limit) => adapter.listConfigRevisions(key, limit),
    getConfigRevisionSnapshot: (key, revision) => adapter.getConfigRevisionSnapshot(key, revision),
    listForwardingPolicies: () => adapter.listForwardingPolicies(),
    upsertForwardingPolicy: (policy, revision) => adapter.upsertForwardingPolicy(policy, revision),
    touchContainer: (id, at) => adapter.touchContainer(id, at),
    recordAudit: (actor, action, resourceType, resourceId, metadata) =>
      adapter.recordAudit(actor, action, resourceType, resourceId, metadata),
    withReleaseActivationLock: (operation) => adapter.withReleaseActivationLock(operation),
    withMaintenanceLease: (name, operation, options) =>
      adapter.withMaintenanceLease(name, operation, options),
    recordRuntimeSample: adapter.recordRuntimeSample
      ? (sample: RuntimeSample) => adapter.recordRuntimeSample!(sample)
      : undefined,
    listRuntimeSamples: adapter.listRuntimeSamples
      ? (instanceId: string, limit?: number) => adapter.listRuntimeSamples!(instanceId, limit)
      : undefined,
    listLatestRuntimeSamples: adapter.listLatestRuntimeSamples
      ? (instanceIds: readonly string[]) => adapter.listLatestRuntimeSamples!(instanceIds)
      : undefined,
    recordHealthCheck: adapter.recordHealthCheck
      ? (check: HealthCheck) => adapter.recordHealthCheck!(check)
      : undefined,
    listHealthChecks: adapter.listHealthChecks
      ? (target?: string, limit?: number) => adapter.listHealthChecks!(target, limit)
      : undefined,
    listAuditEvents: adapter.listAuditEvents
      ? (filter?: AuditEventFilter) => adapter.listAuditEvents!(filter)
      : undefined,
    saveOperation: (operation: AdminOperation) => adapter.saveOperation(operation),
    createOperation: (operation: AdminOperation) => adapter.createOperation(operation),
    compareAndSaveOperation: (operation: AdminOperation, expectedRevision: number) =>
      adapter.compareAndSaveOperation(operation, expectedRevision),
    recoverStaleOperations: (cutoff: string, finishedAt: string) =>
      adapter.recoverStaleOperations(cutoff, finishedAt),
    withRetryLock: <T>(id: string, operation: () => Promise<T>) =>
      adapter.withMaintenanceLease<T>(`operation-retry:${id}`, () => operation()),
    getOperation: (id) => adapter.getOperation(id),
    listOperations: (filter: AdminOperationFilter | undefined) => adapter.listOperations(filter),
    findOperationByIdempotencyKey: (actorUserId, idempotencyKey) =>
      adapter.findOperationByIdempotencyKey(actorUserId, idempotencyKey),
    pruneFinishedOperations: adapter.pruneFinishedOperations
      ? (retentionMs?: number) => adapter.pruneFinishedOperations!(retentionMs)
      : undefined,
  };

  const upgrades: UpgradeRolloutStore = {
    createRollout: (rollout, items) => adapter.createUpgradeRollout(rollout, items),
    findRolloutByIdempotencyKey: (actorUserId, idempotencyKey) =>
      adapter.findUpgradeRolloutByIdempotencyKey(actorUserId, idempotencyKey),
    findLatestRecovery: (actorUserId, instanceId) =>
      adapter.findLatestUpgradeRecovery(actorUserId, instanceId),
    getRollout: (id) => adapter.getUpgradeRollout(id),
    listRollouts: (limit) => adapter.listUpgradeRollouts(limit),
    listActiveTargetReferences: () => adapter.listActiveUpgradeRolloutTargetReferences(),
    listDueItems: (at, limit) => adapter.listDueUpgradeRolloutItems(at, limit),
    listLegacyFirstStartProofItems: adapter.listLegacyFirstStartProofItems
      ? () => adapter.listLegacyFirstStartProofItems!()
      : undefined,
    compareAndSaveItem: (item, expectedRevision) =>
      adapter.compareAndSaveUpgradeRolloutItem(item, expectedRevision),
    supersedeDeferredItemsBefore: (rolloutId, instanceId, at) =>
      adapter.supersedeUpgradeDeferredItemsBefore(rolloutId, instanceId, at),
    commitDeploymentCheckpoint: (item, expectedRevision, at, supersedeEarlier) =>
      adapter.commitUpgradeDeploymentCheckpoint(item, expectedRevision, at, supersedeEarlier),
    compareAndSaveRollout: (rollout, expectedRevision) =>
      adapter.compareAndSaveUpgradeRollout(rollout, expectedRevision),
    recoverInterruptedItems: (cutoff, recoveredAt) =>
      adapter.recoverInterruptedUpgradeRolloutItems(cutoff, recoveredAt),
  };

  const activity: InstanceActivityStore & InstanceUpgradeAdmissionStore = {
    tryOpenLease: (lease, at) => adapter.tryOpenInstanceActivityLease(lease, at),
    renewLease: (lease, at) => adapter.renewInstanceActivityLease(lease, at),
    deleteLease: (id) => adapter.deleteInstanceActivityLease(id),
    closeLease: (id, instanceId, closedAt) => adapter.closeInstanceActivityLease(id, instanceId, closedAt),
    listActiveLeases: (instanceId, heartbeatCutoff) =>
      adapter.listActiveInstanceActivityLeases(instanceId, heartbeatCutoff),
    beginInstanceDraining: (request) => adapter.beginInstanceDraining(request),
    clearInstanceDraining: (instanceId, rolloutId, attemptId) =>
      adapter.clearInstanceDraining(instanceId, rolloutId, attemptId),
    isInstanceDraining: (instanceId, at) => adapter.isInstanceDraining(instanceId, at),
  };

  return {
    initialize: (options?: PersistenceInitializeOptions) => adapter.initialize(options),
    checkReady: async () => {
      if (adapter.checkReady) await adapter.checkReady();
      else await adapter.listApps();
    },
    close: async () => {
      await adapter.close?.();
    },
    identity,
    tenants,
    instances,
    catalog,
    builds,
    admin,
    upgrades,
    activity,
  };
}
