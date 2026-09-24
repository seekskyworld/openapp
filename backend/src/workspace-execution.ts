import type { ContainerStatus, ContainerStopReason } from "./models.js";

export type WorkspaceStatus = "active" | "deleting" | "deleted";
export type WorkspaceDeletionPhase =
  | "draining"
  | "removing_environments"
  | "verifying_references"
  | "releasing_storage"
  | "finalizing"
  | "deleted";
export type WorkspaceExecutionRole = "active" | "candidate" | "previous" | "retired";
export type WorkspaceDesiredState = "running" | "stopped";
export type WorkspaceObservedState = "absent" | "creating" | "running" | "stopped" | "failed" | "unknown";
export type ExecutionTransactionStatus =
  | "requested"
  | "progressing"
  | "applied"
  | "awaiting_first_start"
  | "rolled_back"
  | "failed"
  | "inconsistent";

export interface WorkspaceStorageRef {
  id: string;
  storageClass: string;
  affinity?: { providerId: string; region?: string };
}

export interface Workspace {
  id: string;
  ownerId: string;
  appId: string;
  appRevisionId: string | null;
  storageRefId: string;
  activeExecutionId: string | null;
  status: WorkspaceStatus;
  deletionTransactionId: string | null;
  deletionPhase: WorkspaceDeletionPhase | null;
  deletionFailure: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceExecution {
  id: string;
  workspaceId: string;
  role: WorkspaceExecutionRole;
  providerId: string;
  environmentRef: string | null;
  desiredGeneration: number;
  deployedGeneration: number;
  healthyGeneration: number | null;
  transactionId: string | null;
  transactionStatus: ExecutionTransactionStatus;
  desiredState: WorkspaceDesiredState;
  observedState: WorkspaceObservedState;
  desiredAppRevisionId: string | null;
  desiredLaunchArtifactId: string | null;
  desiredLaunchArtifactReference: string | null;
  launchArtifactId: string | null;
  launchArtifactReference: string | null;
  revision: number;
  /** 迁移期兼容字段；步骤 7 切换 AccessTarget 后不再作为访问真相。 */
  legacyEndpoint: string | null;
  stopReason: ContainerStopReason | null;
  lastActivityAt: string;
  retiredAt: string | null;
  updatedAt: string;
}

export interface LegacyContainerCompatibility {
  runtimeId: string;
  status: ContainerStatus;
}

export interface WorkspaceExecutionProjection {
  workspace: Workspace;
  execution: WorkspaceExecution;
  compatibility: LegacyContainerCompatibility;
}

/** @deprecated 使用 `workspaceExecutionId(workspaceId, "docker")`。 */
export function dockerExecutionId(workspaceId: string): string {
  return workspaceExecutionId(workspaceId, "docker");
}

/** Stable execution identity for a Workspace pinned to one Provider. */
export function workspaceExecutionId(workspaceId: string, providerId: string): string {
  return `${workspaceId}:${providerId}`;
}

export function workspaceStorageRefId(workspaceId: string): string {
  return `workspace-storage:${workspaceId}`;
}

export function workspaceStorageRef(workspace: Workspace, providerId: string): WorkspaceStorageRef {
  return {
    id: workspace.storageRefId,
    storageClass: "workspace-data",
    affinity: { providerId },
  };
}

export function legacyImportTransactionId(workspaceId: string): string {
  return `legacy-import:${workspaceId}`;
}
