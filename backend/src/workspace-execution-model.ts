import type { Container } from "./models.js";
import {
  legacyImportTransactionId,
  workspaceExecutionId,
  workspaceStorageRefId,
  type ExecutionTransactionStatus,
  type WorkspaceDesiredState,
  type WorkspaceExecutionProjection,
} from "./workspace-execution.js";

export class WorkspaceExecutionProjectionError extends Error {
  readonly code = "workspace_execution_projection_mismatch";

  constructor() {
    super("workspace_execution_projection_mismatch");
  }
}

export class WorkspaceExecutionGenerationRollbackError extends Error {
  readonly code = "workspace_execution_generation_rollback";

  constructor() {
    super("workspace_execution_generation_rollback");
  }
}

export class WorkspaceExecutionCasRequiredError extends Error {
  readonly code = "workspace_execution_cas_required";

  constructor() {
    super("workspace_execution_cas_required");
  }
}

/**
 * 旧 Container 行缺少独立代次历史，因此迁移只建立确定性的 active Docker 基线，
 * 不推断不存在的 candidate 或 previous Execution。
 */
export function projectContainerToWorkspaceExecution(container: Container): WorkspaceExecutionProjection {
  const providerId = normalizeProviderId(container.providerId);
  const executionId = workspaceExecutionId(container.id, providerId);
  const desiredState: WorkspaceDesiredState = container.status === "stopped" ? "stopped" : "running";
  const deployedGeneration = container.status === "creating" ? 0 : 1;
  const transactionStatus: ExecutionTransactionStatus = container.status === "creating"
    ? "progressing"
    : container.status === "failed"
      ? "failed"
      : "applied";

  return {
    workspace: {
      id: container.id,
      ownerId: container.userId,
      appId: container.appId,
      appRevisionId: container.appVersionId ?? null,
      storageRefId: workspaceStorageRefId(container.id),
      activeExecutionId: executionId,
      status: "active",
      deletionTransactionId: null,
      deletionPhase: null,
      deletionFailure: null,
      deletedAt: null,
      createdAt: container.createdAt,
      updatedAt: container.updatedAt,
    },
    execution: {
      id: executionId,
      workspaceId: container.id,
      role: "active",
      providerId,
      environmentRef: container.runtimeId === "pending" ? null : container.runtimeId,
      desiredGeneration: 1,
      deployedGeneration,
      healthyGeneration: container.status === "running" ? 1 : null,
      transactionId: legacyImportTransactionId(container.id),
      transactionStatus,
      desiredState,
      observedState: container.status,
      desiredAppRevisionId: container.appVersionId ?? null,
      desiredLaunchArtifactId: container.imageArtifactId ?? null,
      desiredLaunchArtifactReference: container.imageReference ?? null,
      launchArtifactId: container.imageArtifactId ?? null,
      launchArtifactReference: container.imageReference ?? null,
      revision: 1,
      legacyEndpoint: container.endpoint,
      stopReason: container.stopReason,
      lastActivityAt: container.lastActivityAt,
      retiredAt: null,
      updatedAt: container.updatedAt,
    },
    compatibility: {
      runtimeId: container.runtimeId,
      status: container.status,
    },
  };
}

export function projectWorkspaceExecutionToContainer(projection: WorkspaceExecutionProjection): Container {
  const { workspace, execution, compatibility } = projection;
  const activeShape = workspace.status !== "deleted"
    && workspace.activeExecutionId === execution.id
    && execution.role === "active"
    && execution.environmentRef === (compatibility.runtimeId === "pending" ? null : compatibility.runtimeId);
  const deletedShape = workspace.status === "deleted"
    && workspace.activeExecutionId === null
    && execution.role === "retired"
    && execution.environmentRef === null
    && execution.observedState === "absent"
    && compatibility.runtimeId === "deleted"
    && compatibility.status === "stopped";
  if (
    (!activeShape && !deletedShape)
    || execution.workspaceId !== workspace.id
    || !validProviderId(execution.providerId)
    || (workspace.status !== "deleted" && execution.observedState !== compatibility.status)
    || execution.desiredGeneration < execution.deployedGeneration
    || (execution.healthyGeneration !== null && execution.healthyGeneration > execution.deployedGeneration)
    || execution.revision < 1
    || !validDeletionState(workspace)
  ) {
    throw new WorkspaceExecutionProjectionError();
  }

  return {
    id: workspace.id,
    userId: workspace.ownerId,
    appId: workspace.appId,
    runtimeId: compatibility.runtimeId,
    status: compatibility.status,
    endpoint: execution.legacyEndpoint,
    stopReason: execution.stopReason,
    createdAt: workspace.createdAt,
    updatedAt: execution.updatedAt,
    lastActivityAt: execution.lastActivityAt,
    appVersionId: workspace.appRevisionId,
    imageArtifactId: execution.launchArtifactId,
    imageReference: execution.launchArtifactReference,
    ...(execution.providerId === "docker" ? {} : { providerId: execution.providerId }),
  };
}

export function assertWorkspaceExecutionTransition(
  current: WorkspaceExecutionProjection,
  next: WorkspaceExecutionProjection,
): void {
  projectWorkspaceExecutionToContainer(current);
  projectWorkspaceExecutionToContainer(next);
  if (
    current.workspace.id !== next.workspace.id
    || current.workspace.ownerId !== next.workspace.ownerId
    || current.workspace.createdAt !== next.workspace.createdAt
    || current.workspace.storageRefId !== next.workspace.storageRefId
    || current.execution.id !== next.execution.id
    || current.execution.workspaceId !== next.execution.workspaceId
    || current.execution.providerId !== next.execution.providerId
    || !validWorkspaceStatusTransition(current.workspace.status, next.workspace.status)
  ) {
    throw new WorkspaceExecutionProjectionError();
  }
  if (
    next.execution.desiredGeneration < current.execution.desiredGeneration
    || next.execution.deployedGeneration < current.execution.deployedGeneration
    || generationValue(next.execution.healthyGeneration) < generationValue(current.execution.healthyGeneration)
  ) {
    throw new WorkspaceExecutionGenerationRollbackError();
  }
}

function validDeletionState(workspace: WorkspaceExecutionProjection["workspace"]): boolean {
  if (workspace.status === "active") {
    return workspace.deletionTransactionId === null
      && workspace.deletionPhase === null
      && workspace.deletionFailure === null
      && workspace.deletedAt === null;
  }
  if (!workspace.deletionTransactionId || !workspace.deletionPhase) return false;
  if (workspace.status === "deleting") {
    return workspace.deletionPhase !== "deleted" && workspace.deletedAt === null;
  }
  return workspace.deletionPhase === "deleted" && workspace.deletedAt !== null;
}

function validWorkspaceStatusTransition(
  current: WorkspaceExecutionProjection["workspace"]["status"],
  next: WorkspaceExecutionProjection["workspace"]["status"],
): boolean {
  if (current === "active") return next === "active" || next === "deleting";
  if (current === "deleting") return next === "deleting" || next === "deleted";
  return next === "deleted";
}

function generationValue(value: number | null): number {
  return value ?? -1;
}

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u;

function normalizeProviderId(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || "docker";
  if (!PROVIDER_ID_PATTERN.test(normalized)) throw new WorkspaceExecutionProjectionError();
  return normalized;
}

function validProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value);
}
