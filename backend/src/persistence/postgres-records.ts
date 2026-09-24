/** 数据库行、参数与领域对象的纯转换；不拥有连接池或事务。 */
import type { AdminOperation } from "../admin-operations.js";
import { APP_ID_PATTERN } from "../app-id.js";
import { withVersionPackageProjection } from "../app-version-packages.js";
import type { AuthProviderId } from "../auth/types.js";
import type { InstanceActivityLease } from "../instance-upgrade-activity.js";
import type {
  AppDefinition,
  AppVersion,
  BuildPackage,
  BuildStrategy,
  ConfigEffect,
  ConfigRevision,
  ConfigRevisionSnapshot,
  Container,
  ImageArtifact,
  ImageBuild,
  Tenant,
  TenantMembership,
  WorkspaceTenantBinding,
} from "../models.js";
import type { AuditEvent, HealthCheck, RuntimeSample } from "../monitoring-types.js";
import type { UpgradeRollout, UpgradeRolloutItem } from "../upgrade-rollouts.js";
import {
  projectWorkspaceExecutionToContainer,
  WorkspaceExecutionProjectionError,
} from "../workspace-execution-model.js";
import { workspaceExecutionId, type WorkspaceExecutionProjection } from "../workspace-execution.js";

export { UPGRADE_ROLLOUT_COLUMNS, UPGRADE_ROLLOUT_ITEM_COLUMNS, UPGRADE_ROLLOUT_ITEM_COLUMNS_QUALIFIED };

export function containerSelect(suffix: string): string {
  return `select ${containerColumns()} from containers ${suffix}`;
}

export function containerColumns(): string {
  return `id,user_id as "userId",app_id as "appId",app_version_id as "appVersionId",
    image_artifact_id as "imageArtifactId",image_reference as "imageReference",
    runtime_id as "runtimeId",status,endpoint,stop_reason as "stopReason",created_at as "createdAt",
    updated_at as "updatedAt",last_activity_at as "lastActivityAt",workspace_status as "workspaceStatus",
    storage_ref_id as "storageRefId",active_execution_id as "activeExecutionId",provider_id as "providerId",
    environment_ref as "environmentRef",execution_role as "executionRole",
    desired_generation::text as "desiredGeneration",deployed_generation::text as "deployedGeneration",
    healthy_generation::text as "healthyGeneration",transaction_id as "transactionId",
    transaction_status as "transactionStatus",desired_state as "desiredState",observed_state as "observedState",
    desired_app_revision_id as "desiredAppRevisionId",desired_launch_artifact_id as "desiredLaunchArtifactId",
    desired_launch_artifact_reference as "desiredLaunchArtifactReference",
    execution_revision::text as "executionRevision",execution_image_artifact_id as "executionImageArtifactId",
    execution_image_reference as "executionImageReference",execution_endpoint as "executionEndpoint",
    execution_model_version as "executionModelVersion",
    deletion_transaction_id as "deletionTransactionId",deletion_phase as "deletionPhase",
    deletion_failure as "deletionFailure",deleted_at as "deletedAt"`;
}

export function numberedSqlValues(count: number): string {
  return Array.from({ length: count }, (_, index) => `$${index + 1}`).join(",");
}

export function containerWriteValues(
  container: Container,
  projection: WorkspaceExecutionProjection,
): unknown[] {
  return [
    container.id,
    container.userId,
    container.appId,
    container.appVersionId ?? null,
    container.imageArtifactId ?? null,
    container.imageReference ?? null,
    container.runtimeId,
    container.status,
    container.endpoint,
    container.stopReason,
    container.createdAt,
    container.updatedAt,
    container.lastActivityAt,
    ...workspaceExecutionUpdateValues(projection),
  ];
}

export function workspaceExecutionUpdateValues(projection: WorkspaceExecutionProjection): unknown[] {
  const { workspace, execution } = projection;
  return [
    workspace.status,
    workspace.storageRefId,
    workspace.activeExecutionId,
    execution.providerId,
    execution.environmentRef,
    execution.role,
    execution.desiredGeneration,
    execution.deployedGeneration,
    execution.healthyGeneration,
    execution.transactionId,
    execution.transactionStatus,
    execution.desiredState,
    execution.observedState,
    execution.desiredAppRevisionId,
    execution.desiredLaunchArtifactId,
    execution.desiredLaunchArtifactReference,
    execution.revision,
    execution.launchArtifactId,
    execution.launchArtifactReference,
    execution.legacyEndpoint,
    2,
    workspace.deletionTransactionId,
    workspace.deletionPhase,
    workspace.deletionFailure,
    workspace.deletedAt,
  ];
}

export function appVersionColumns(): string {
  return `id,app_id as "appId",revision::text as revision,version,build_id as "buildId",packages,image_artifact_id as "imageArtifactId",
    image_reference as "imageReference",runtime_contract as "runtimeContract",source_kind as "sourceKind",status,
    created_at as "createdAt",activated_at as "activatedAt"`;
}

export function appVersionSelect(suffix: string): string {
  return `select ${appVersionColumns()} from app_versions ${suffix}`;
}

export function appVersionInsert(): string {
  return `insert into app_versions(id,app_id,revision,version,build_id,packages,image_artifact_id,image_reference,runtime_contract,status,created_at,activated_at,source_kind)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`;
}

export function appVersionValues(version: AppVersion, revision: number): unknown[] {
  const projected = withVersionPackageProjection(version);
  return [
    projected.id,
    projected.appId,
    revision,
    projected.version,
    projected.buildId,
    JSON.stringify(projected.packages),
    projected.imageArtifactId ?? null,
    projected.imageReference,
    projected.runtimeContract ?? null,
    projected.status,
    projected.createdAt,
    projected.activatedAt,
    projected.sourceKind ?? "packages",
  ];
}

export function imageBuildColumns(): string {
  return `id,strategy_id as "strategyId",strategy_snapshot as "strategySnapshot",operation_id as "operationId",
    source_app_version_id as "sourceAppVersionId",
    requested_by as "requestedBy",packages,status,error,created_at as "createdAt",started_at as "startedAt",
    finished_at as "finishedAt"`;
}

export function buildPackageSelect(suffix: string): string {
  return `select id,strategy_id as "strategyId",slot_key as "key",artifact,original_name as "originalName",
    storage_key as "storageKey",uploaded_by as "uploadedBy",source_version as "sourceVersion",
    source_build_id as "sourceBuildId",inspected_at as "inspectedAt",created_at as "createdAt" from build_packages ${suffix}`;
}

export function imageBuildSelect(suffix: string): string {
  return `select ${imageBuildColumns()} from image_builds ${suffix}`;
}

export function imageBuildValues(build: ImageBuild): unknown[] {
  return [
    build.id,
    build.strategyId,
    JSON.stringify(build.strategySnapshot),
    build.operationId,
    build.sourceAppVersionId,
    build.requestedBy,
    JSON.stringify(build.packages),
    build.status,
    build.error,
    build.createdAt,
    build.startedAt,
    build.finishedAt,
  ];
}

export function imageArtifactSelect(suffix: string): string {
  return `select id,build_id as "buildId",image_reference as "imageReference",image_id as "imageId",
    runtime_contract as "runtimeContract",created_at as "createdAt" from image_artifacts ${suffix}`;
}

export type ContainerRow = Omit<Container, "createdAt" | "updatedAt" | "lastActivityAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
  lastActivityAt: Date | string;
  workspaceStatus: WorkspaceExecutionProjection["workspace"]["status"];
  storageRefId: string;
  activeExecutionId: string | null;
  providerId: string;
  environmentRef: string | null;
  executionRole: WorkspaceExecutionProjection["execution"]["role"];
  desiredGeneration: string | number;
  deployedGeneration: string | number;
  healthyGeneration: string | number | null;
  transactionId: string | null;
  transactionStatus: WorkspaceExecutionProjection["execution"]["transactionStatus"];
  desiredState: WorkspaceExecutionProjection["execution"]["desiredState"];
  observedState: WorkspaceExecutionProjection["execution"]["observedState"];
  desiredAppRevisionId: string | null;
  desiredLaunchArtifactId: string | null;
  desiredLaunchArtifactReference: string | null;
  executionRevision: string | number;
  executionImageArtifactId: string | null;
  executionImageReference: string | null;
  executionEndpoint: string | null;
  executionModelVersion: number;
  deletionTransactionId: string | null;
  deletionPhase: WorkspaceExecutionProjection["workspace"]["deletionPhase"];
  deletionFailure: string | null;
  deletedAt: Date | string | null;
};

export type TenantRow = Omit<Tenant, "createdAt" | "updatedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type TenantMembershipRow = TenantRow & {
  tenantId: string;
  userId: string;
  membershipRole: TenantMembership["role"];
  membershipCreatedAt: Date | string;
  membershipUpdatedAt: Date | string;
};

export type WorkspaceTenantBindingRow = Omit<WorkspaceTenantBinding, "createdAt" | "updatedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type AppVersionRow = Omit<AppVersion, "revision" | "createdAt" | "activatedAt"> & {
  revision: string | number;
  createdAt: Date | string;
  activatedAt: Date | string | null;
};

export type BuildStrategyRow = Omit<BuildStrategy, "createdAt" | "updatedAt"> & {
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type BuildPackageRow = Omit<BuildPackage, "inspectedAt" | "createdAt"> & {
  inspectedAt: Date | string | null;
  createdAt: Date | string;
};

export type ImageBuildRow = Omit<ImageBuild, "createdAt" | "startedAt" | "finishedAt"> & {
  createdAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
};

export type ImageArtifactRow = Omit<ImageArtifact, "createdAt"> & { createdAt: Date | string };

export function mapApp(value: AppDefinition): AppDefinition {
  return { ...value, createdAt: toIsoString(value.createdAt), updatedAt: toIsoString(value.updatedAt) };
}

export function mapAppVersion(row: AppVersionRow): AppVersion {
  return withVersionPackageProjection({
    ...row,
    revision: Number(row.revision),
    packages: Array.isArray(row.packages) ? structuredClone(row.packages) : undefined,
    createdAt: toIsoString(row.createdAt),
    activatedAt: row.activatedAt === null ? null : toIsoString(row.activatedAt),
  });
}

export function mapBuildStrategy(row: BuildStrategyRow): BuildStrategy {
  return {
    ...row,
    packageRequirements: structuredClone(row.packageRequirements),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

export function mapBuildPackage(row: BuildPackageRow): BuildPackage {
  return {
    ...row,
    artifact: structuredClone(row.artifact),
    inspectedAt: row.inspectedAt === null ? null : toIsoString(row.inspectedAt),
    createdAt: toIsoString(row.createdAt),
  };
}

export function mapImageBuild(row: ImageBuildRow): ImageBuild {
  return {
    ...row,
    strategySnapshot: structuredClone(row.strategySnapshot),
    packages: structuredClone(row.packages),
    createdAt: toIsoString(row.createdAt),
    startedAt: row.startedAt === null ? null : toIsoString(row.startedAt),
    finishedAt: row.finishedAt === null ? null : toIsoString(row.finishedAt),
  };
}

export function mapImageArtifact(row: ImageArtifactRow): ImageArtifact {
  return { ...row, createdAt: toIsoString(row.createdAt) };
}

export function mapTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

export function mapTenantMembership(row: TenantMembershipRow): TenantMembership {
  return {
    tenantId: row.tenantId,
    userId: row.userId,
    role: row.membershipRole,
    createdAt: toIsoString(row.membershipCreatedAt),
    updatedAt: toIsoString(row.membershipUpdatedAt),
  };
}

export function mapWorkspaceTenantBinding(row: WorkspaceTenantBindingRow): WorkspaceTenantBinding {
  return {
    workspaceId: row.workspaceId,
    tenantId: row.tenantId,
    ownerId: row.ownerId,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

export function mapContainer(row: ContainerRow): Container {
  return projectWorkspaceExecutionToContainer(mapWorkspaceExecutionProjection(row));
}

export function mapLegacyContainer(row: ContainerRow): Container {
  return {
    id: row.id,
    userId: row.userId,
    appId: row.appId,
    runtimeId: row.runtimeId,
    status: row.status,
    endpoint: row.endpoint,
    stopReason: row.stopReason,
    appVersionId: row.appVersionId,
    imageArtifactId: row.imageArtifactId,
    imageReference: row.imageReference,
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    lastActivityAt: toIsoString(row.lastActivityAt),
  };
}

export function mapWorkspaceExecutionProjection(row: ContainerRow): WorkspaceExecutionProjection {
  if (row.executionModelVersion < 2) throw new WorkspaceExecutionProjectionError();
  const legacy = mapLegacyContainer(row);
  const projection: WorkspaceExecutionProjection = {
    workspace: {
      id: legacy.id,
      ownerId: legacy.userId,
      appId: legacy.appId,
      appRevisionId: legacy.appVersionId ?? null,
      storageRefId: row.storageRefId,
      activeExecutionId: row.activeExecutionId,
      status: row.workspaceStatus,
      deletionTransactionId: row.deletionTransactionId,
      deletionPhase: row.deletionPhase,
      deletionFailure: row.deletionFailure,
      deletedAt: row.deletedAt === null ? null : toIsoString(row.deletedAt),
      createdAt: legacy.createdAt,
      updatedAt: legacy.updatedAt,
    },
    execution: {
      id: row.activeExecutionId ?? workspaceExecutionId(legacy.id, row.providerId || "docker"),
      workspaceId: legacy.id,
      role: row.executionRole,
      providerId: row.providerId,
      environmentRef: row.environmentRef,
      desiredGeneration: Number(row.desiredGeneration),
      deployedGeneration: Number(row.deployedGeneration),
      healthyGeneration: row.healthyGeneration === null ? null : Number(row.healthyGeneration),
      transactionId: row.transactionId,
      transactionStatus: row.transactionStatus,
      desiredState: row.desiredState,
      observedState: row.observedState,
      desiredAppRevisionId: row.desiredAppRevisionId,
      desiredLaunchArtifactId: row.desiredLaunchArtifactId,
      desiredLaunchArtifactReference: row.desiredLaunchArtifactReference,
      launchArtifactId: row.executionImageArtifactId,
      launchArtifactReference: row.executionImageReference,
      revision: Number(row.executionRevision),
      legacyEndpoint: row.executionEndpoint,
      stopReason: legacy.stopReason,
      lastActivityAt: legacy.lastActivityAt,
      retiredAt:
        row.workspaceStatus === "deleted" && row.deletedAt !== null ? toIsoString(row.deletedAt) : null,
      updatedAt: legacy.updatedAt,
    },
    compatibility: {
      runtimeId: legacy.runtimeId,
      status: legacy.status,
    },
  };
  const reconstructed = projectWorkspaceExecutionToContainer(projection);
  if (!sameContainerCompatibility(legacy, reconstructed)) throw new WorkspaceExecutionProjectionError();
  return projection;
}

export function sameContainerCompatibility(left: Container, right: Container): boolean {
  return (
    left.id === right.id &&
    left.userId === right.userId &&
    left.appId === right.appId &&
    left.runtimeId === right.runtimeId &&
    left.status === right.status &&
    left.endpoint === right.endpoint &&
    left.stopReason === right.stopReason &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.lastActivityAt === right.lastActivityAt &&
    (left.appVersionId ?? null) === (right.appVersionId ?? null) &&
    (left.imageArtifactId ?? null) === (right.imageArtifactId ?? null) &&
    (left.imageReference ?? null) === (right.imageReference ?? null)
  );
}

export type ConfigRevisionRow = {
  key: string;
  revision: string | number;
  updatedBy: string;
  updatedAt: Date | string;
  effect: ConfigEffect;
  effectiveAt: Date | string | null;
};

export type ConfigRevisionSnapshotRow = ConfigRevisionRow & { payload: unknown };

export function mapConfigRevision(row: ConfigRevisionRow): ConfigRevision {
  return {
    key: row.key,
    revision: Number(row.revision),
    updatedBy: row.updatedBy,
    updatedAt: toIsoString(row.updatedAt),
    effect: row.effect,
    effectiveAt: row.effectiveAt === null ? null : toIsoString(row.effectiveAt),
  };
}

export function mapConfigRevisionSnapshot(row: ConfigRevisionSnapshotRow): ConfigRevisionSnapshot {
  return { ...mapConfigRevision(row), payload: structuredClone(row.payload) };
}

export type RuntimeSampleRow = Omit<RuntimeSample, "sampledAt"> & { sampledAt: Date | string };
export type HealthCheckRow = Omit<HealthCheck, "checkedAt"> & { checkedAt: Date | string };
export type AuditEventRow = Omit<AuditEvent, "createdAt"> & { createdAt: Date | string };
export type AdminOperationRow = Omit<
  AdminOperation,
  "revision" | "createdAt" | "startedAt" | "heartbeatAt" | "finishedAt"
> & {
  revision: number | string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  heartbeatAt: Date | string | null;
  finishedAt: Date | string | null;
};

export function mapRuntimeSample(row: RuntimeSampleRow): RuntimeSample {
  return { ...row, sampledAt: toIsoString(row.sampledAt) };
}

export function mapHealthCheck(row: HealthCheckRow): HealthCheck {
  return { ...row, checkedAt: toIsoString(row.checkedAt) };
}

export function mapAuditEvent(row: AuditEventRow): AuditEvent {
  return { ...row, createdAt: toIsoString(row.createdAt) };
}

export function mapOperation(row: AdminOperationRow): AdminOperation {
  return {
    ...row,
    revision: Number(row.revision),
    createdAt: toIsoString(row.createdAt),
    startedAt: row.startedAt === null ? null : toIsoString(row.startedAt),
    heartbeatAt: row.heartbeatAt === null ? null : toIsoString(row.heartbeatAt),
    finishedAt: row.finishedAt === null ? null : toIsoString(row.finishedAt),
  };
}

export function operationInsertValues(operation: AdminOperation): unknown[] {
  return [
    operation.id,
    operation.revision,
    operation.type,
    operation.status,
    operation.progress,
    operation.stage,
    operation.actorUserId,
    operation.resourceType,
    operation.resourceId,
    operation.requestId,
    operation.idempotencyKey,
    operation.requestFingerprint,
    operation.retryOf,
    operation.cancellable,
    operation.retryable,
    operation.result === null ? null : JSON.stringify(operation.result),
    operation.error,
    operation.createdAt,
    operation.startedAt,
    operation.heartbeatAt,
    operation.finishedAt,
  ];
}

const UPGRADE_ROLLOUT_COLUMNS = `id,revision::text as revision,actor_user_id as "actorUserId",status,
  task_kind as "taskKind",use_latest_version as "useLatestVersion",requested,completed,succeeded,superseded,failed,waiting,upgrading,
  needs_attention as "needsAttention",
  idempotency_key as "idempotencyKey",request_fingerprint as "requestFingerprint",
  created_at as "createdAt",updated_at as "updatedAt",finished_at as "finishedAt"`;

const UPGRADE_ROLLOUT_ITEM_COLUMNS = `rollout_id as "rolloutId",instance_id as "instanceId",position,
  revision::text as revision,user_id as "userId",app_id as "appId",source_status as "sourceStatus",
  desired_state as "desiredState",source_app_version_id as "sourceAppVersionId",
  source_image_artifact_id as "sourceImageArtifactId",source_image_reference as "sourceImageReference",
  target_app_version_id as "targetAppVersionId",
  target_image_artifact_id as "targetImageArtifactId",target_image_reference as "targetImageReference",
  target_runtime_contract as "targetRuntimeContract",launch_profile as "launchProfile",recovery,status,blocker,error,diagnostics,
  force_requested as "forceRequested",attempt_id as "attemptId",attempt_count as "attemptCount",next_attempt_at as "nextAttemptAt",
  last_checked_at as "lastCheckedAt",started_at as "startedAt",finished_at as "finishedAt",
  created_at as "createdAt",updated_at as "updatedAt"`;

const UPGRADE_ROLLOUT_ITEM_COLUMNS_QUALIFIED = `i.rollout_id as "rolloutId",i.instance_id as "instanceId",i.position,
  i.revision::text as revision,i.user_id as "userId",i.app_id as "appId",i.source_status as "sourceStatus",
  i.desired_state as "desiredState",i.source_app_version_id as "sourceAppVersionId",
  i.source_image_artifact_id as "sourceImageArtifactId",i.source_image_reference as "sourceImageReference",
  i.target_app_version_id as "targetAppVersionId",
  i.target_image_artifact_id as "targetImageArtifactId",i.target_image_reference as "targetImageReference",
  i.target_runtime_contract as "targetRuntimeContract",i.launch_profile as "launchProfile",i.recovery,i.status,i.blocker,i.error,i.diagnostics,
  i.force_requested as "forceRequested",i.attempt_id as "attemptId",i.attempt_count as "attemptCount",i.next_attempt_at as "nextAttemptAt",
  i.last_checked_at as "lastCheckedAt",i.started_at as "startedAt",i.finished_at as "finishedAt",
  i.created_at as "createdAt",i.updated_at as "updatedAt"`;

export type UpgradeRolloutRow = Omit<
  UpgradeRollout,
  "revision" | "createdAt" | "updatedAt" | "finishedAt"
> & {
  revision: number | string;
  createdAt: Date | string;
  updatedAt: Date | string;
  finishedAt: Date | string | null;
};

export type UpgradeRolloutItemRow = Omit<
  UpgradeRolloutItem,
  "revision" | "nextAttemptAt" | "lastCheckedAt" | "startedAt" | "finishedAt" | "createdAt" | "updatedAt"
> & {
  revision: number | string;
  nextAttemptAt: Date | string | null;
  lastCheckedAt: Date | string | null;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
};

export type InstanceActivityLeaseRow = Omit<
  InstanceActivityLease,
  "openedAt" | "heartbeatAt" | "lastActivityAt"
> & {
  openedAt: Date | string;
  heartbeatAt: Date | string;
  lastActivityAt: Date | string;
};

export function mapUpgradeRollout(row: UpgradeRolloutRow): UpgradeRollout {
  const { superseded, ...rest } = row;
  return {
    ...rest,
    ...(Number(superseded ?? 0) > 0 ? { superseded: Number(superseded) } : {}),
    revision: Number(row.revision),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
    finishedAt: row.finishedAt === null ? null : toIsoString(row.finishedAt),
  };
}

export function mapUpgradeRolloutItem(row: UpgradeRolloutItemRow): UpgradeRolloutItem {
  return {
    ...row,
    launchProfile: structuredClone(row.launchProfile),
    revision: Number(row.revision),
    nextAttemptAt: row.nextAttemptAt === null ? null : toIsoString(row.nextAttemptAt),
    lastCheckedAt: row.lastCheckedAt === null ? null : toIsoString(row.lastCheckedAt),
    startedAt: row.startedAt === null ? null : toIsoString(row.startedAt),
    finishedAt: row.finishedAt === null ? null : toIsoString(row.finishedAt),
    createdAt: toIsoString(row.createdAt),
    updatedAt: toIsoString(row.updatedAt),
  };
}

export function mapInstanceActivityLease(row: InstanceActivityLeaseRow): InstanceActivityLease {
  return {
    ...row,
    openedAt: toIsoString(row.openedAt),
    heartbeatAt: toIsoString(row.heartbeatAt),
    lastActivityAt: toIsoString(row.lastActivityAt),
  };
}

export function upgradeRolloutInsertValues(rollout: UpgradeRollout): unknown[] {
  return [
    rollout.id,
    rollout.revision,
    rollout.actorUserId,
    rollout.status,
    rollout.taskKind,
    rollout.useLatestVersion,
    rollout.requested,
    rollout.completed,
    rollout.succeeded,
    rollout.superseded ?? 0,
    rollout.failed,
    rollout.waiting,
    rollout.upgrading,
    rollout.needsAttention,
    rollout.idempotencyKey,
    rollout.requestFingerprint,
    rollout.createdAt,
    rollout.updatedAt,
    rollout.finishedAt,
  ];
}

export function upgradeRolloutItemInsertValues(item: UpgradeRolloutItem): unknown[] {
  return [
    item.rolloutId,
    item.instanceId,
    item.position,
    item.revision,
    item.userId,
    item.appId,
    item.sourceStatus,
    item.desiredState,
    item.sourceAppVersionId,
    item.sourceImageArtifactId,
    item.sourceImageReference,
    item.targetAppVersionId,
    item.targetImageArtifactId,
    item.targetImageReference,
    item.targetRuntimeContract,
    JSON.stringify(item.launchProfile),
    item.recovery === true,
    item.status,
    item.blocker,
    item.error,
    item.diagnostics === undefined ? null : JSON.stringify(item.diagnostics),
    item.forceRequested,
    item.attemptId,
    item.attemptCount,
    item.nextAttemptAt,
    item.lastCheckedAt,
    item.startedAt,
    item.finishedAt,
    item.createdAt,
    item.updatedAt,
  ];
}

export function clampLimit(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(500, Math.floor(value))) : 60;
}

export function clampOffset(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function isPostgresUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23505");
}

export function normalizeAuthProvider(provider: AuthProviderId | "local"): AuthProviderId | "local" {
  const normalized = provider.trim().toLowerCase();
  if (!normalized || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(normalized)) {
    throw new Error("default_auth_provider_invalid");
  }
  return normalized;
}

export function normalizeOptionalAppId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!APP_ID_PATTERN.test(normalized)) throw new Error("default_app_id_invalid");
  return normalized;
}

export function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function isPostgresForeignKeyViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "23503");
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
