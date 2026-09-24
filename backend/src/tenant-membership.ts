import type { Tenant, TenantMembership, WorkspaceTenantBinding } from "./models.js";
import type { TenantStore } from "./stores-contracts.js";

/**
 * M5 的兼容身份规则：每个旧 User 都有一个确定性的 Personal Tenant。
 * 该 id 只用于服务端关联，旧 API 不会返回它。
 */
export function personalTenantId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized) throw new TenantMembershipError("tenant_user_required");
  return `personal:${normalized}`;
}

export class TenantMembershipError extends Error {
  constructor(readonly code: "tenant_user_required" | "tenant_workspace_binding_conflict" | "tenant_membership_required") {
    super(code);
  }
}

export interface WorkspaceTenantAccessPort {
  ensureWorkspaceBinding(workspaceId: string, ownerId: string): Promise<WorkspaceTenantBinding>;
  requireWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceTenantBinding>;
}

/**
 * 只编排 Tenant 投影，不拥有 Workspace 生命周期。这样旧 Container 读写可以
 * 继续运行，授权切换也能在一个 feature flag/版本窗口内回滚。
 */
export class TenantMembershipService implements WorkspaceTenantAccessPort {
  constructor(private readonly store: TenantStore) {}

  async ensureWorkspaceBinding(workspaceId: string, ownerId: string): Promise<WorkspaceTenantBinding> {
    const { tenant, membership } = await this.store.ensurePersonalTenant(ownerId);
    if (membership.role !== "owner" && membership.role !== "admin") {
      throw new TenantMembershipError("tenant_membership_required");
    }
    const existing = await this.store.getWorkspaceTenantBinding(workspaceId);
    if (existing) {
      if (existing.tenantId !== tenant.id || existing.ownerId !== ownerId) {
        throw new TenantMembershipError("tenant_workspace_binding_conflict");
      }
      return existing;
    }
    const bound = await this.store.bindWorkspaceToTenant(workspaceId, tenant.id, ownerId);
    if (!bound) {
      throw new TenantMembershipError("tenant_workspace_binding_conflict");
    }
    return bound;
  }

  async requireWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceTenantBinding> {
    const binding = await this.store.getWorkspaceTenantBinding(workspaceId);
    if (!binding) {
      // 历史行在首次访问时确定性投影到用户的 Personal Tenant；不改变数据或 Container ID。
      return this.ensureWorkspaceBinding(workspaceId, userId);
    }
    const memberships = await this.store.listTenantMemberships(userId);
    if (!memberships.some((entry) => entry.tenant.id === binding.tenantId)) {
      throw new TenantMembershipError("tenant_membership_required");
    }
    return binding;
  }

  async ensurePersonalTenant(userId: string): Promise<{ tenant: Tenant; membership: TenantMembership }> {
    return this.store.ensurePersonalTenant(userId);
  }
}
