export type UserRole = "user" | "admin" | "super_admin";

export class UserRoleUpdateError extends Error {
  constructor(readonly code:
    | "credential_update_conflict"
    | "last_super_admin_cannot_be_demoted"
    | "local_credentials_required"
    | "role_change_conflict"
    | "self_role_change_forbidden"
    | "super_admin_required"
    | "target_role_not_manageable") {
    super(code);
  }
}

export interface UserRoleChangeInput {
  actorUserId: string;
  targetUserId: string;
  expectedRole: UserRole;
  role: UserRole;
  passwordHash?: string;
}

export interface ManagedLocalUserCreateInput {
  actorUserId: string;
  email: string;
  passwordHash: string;
  role: UserRole;
}

/** Describes when a control-plane configuration change takes effect. */
export type ConfigEffect = "immediate" | "new_instances" | "restart" | "rebuild";

/** Durable metadata for an administrator configuration revision. */
export interface ConfigRevision {
  key: string;
  revision: number;
  updatedBy: string;
  updatedAt: string;
  effect: ConfigEffect;
  effectiveAt: string | null;
}

export interface ConfigRevisionInput {
  updatedBy?: string;
  effect?: ConfigEffect;
  effectiveAt?: string | null;
  expectedRevision?: number;
  payload?: unknown;
}

export interface ConfigRevisionSnapshot extends ConfigRevision {
  payload: unknown;
}

export class ConfigRevisionConflictError extends Error {
  readonly code = "config_revision_conflict";

  constructor() {
    super("config_revision_conflict");
  }
}

/** Authentication source attached to a request-scoped User projection. */
export type AuthMethod = "local" | "cli" | (string & {});

export interface AccountAuthState {
  hasLocalCredential: boolean;
  externalProviders: string[];
}

export interface User {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
  appInitializedAt: string | null;
}

export type TenantKind = "personal" | "organization";
export type TenantMembershipRole = "owner" | "admin" | "member";

/** 隔离和配额的业务边界；与旧 User/Container 身份保持独立。 */
export interface Tenant {
  id: string;
  kind: TenantKind;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface TenantMembership {
  tenantId: string;
  userId: string;
  role: TenantMembershipRole;
  createdAt: string;
  updatedAt: string;
}

/** Workspace 与 Tenant 的兼容投影，不把 tenantId 泄露到旧 Container DTO。 */
export interface WorkspaceTenantBinding {
  workspaceId: string;
  tenantId: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthenticatedUser extends User {
  /** Authentication source for this session; never used as a role source. */
  authMethod: AuthMethod;
  /** Forces an SSO-created account through local password setup before business routes. */
  passwordSetupRequired: boolean;
  /** External providers linked to this account. */
  linkedProviders: string[];
}

export type AppStatus = "active" | "archived";

/** A catalog entry; credential behavior is selected by reviewed server code. */
export interface AppDefinition {
  id: string;
  name: string;
  description: string;
  authAdapterId: string;
  status: AppStatus;
  createdAt: string;
  updatedAt: string;
}

// 构建数据协议与 Adapter 共用一个定义，避免宿主和插件结构漂移。
import type { AppVersionStatus, AppArtifact, BuildStrategyStatus, BuildPackageRequirement, BuildStrategy, BuildPackage, ImageBuildPackage, ImageBuildStatus, ImageBuild, ImageArtifact, AppVersion } from "@openapp/contracts";
export type { AppVersionStatus, AppArtifact, BuildStrategyStatus, BuildPackageRequirement, BuildStrategy, BuildPackage, ImageBuildPackage, ImageBuildStatus, ImageBuild, ImageArtifact, AppVersion } from "@openapp/contracts";

export class AppCatalogError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export type ContainerStatus = "creating" | "running" | "stopped" | "failed";
export type ContainerStopReason = "idle" | "manual_user" | "manual_admin" | "failure";

export interface Container {
  id: string;
  userId: string;
  appId: string;
  /** Provider pin for new projections; omitted legacy rows are Docker. */
  providerId?: string;
  runtimeId: string;
  status: ContainerStatus;
  endpoint: string | null;
  stopReason: ContainerStopReason | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
  /** Version and image are snapshots; changing the catalog never mutates an instance. */
  appVersionId?: string | null;
  imageArtifactId?: string | null;
  imageReference?: string | null;
}

export interface ForwardingPolicy {
  id: string;
  name: string;
  targetBaseUrl: string;
  allowedHosts: string[];
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}
