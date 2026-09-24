import { HttpError } from "./http-response.js";
import type { Container } from "./models.js";
import { TenantMembershipError, type WorkspaceTenantAccessPort } from "./tenant-membership.js";

interface WorkspaceAuthorizationStore {
  getContainer(id: string): Promise<Container | null>;
}

export interface WorkspaceAuthorizationPort {
  requireExisting(id: string): Promise<Container>;
  requireOwned(id: string, userId: string): Promise<Container>;
}

/**
 * Workspace 所有权校验位于服务层，HTTP Gateway 只编排认证和访问流程，
 * 不直接读取持久化仓储。
 */
export class WorkspaceAuthorizationService implements WorkspaceAuthorizationPort {
  readonly #store: WorkspaceAuthorizationStore;

  constructor(
    store: WorkspaceAuthorizationStore,
    private readonly tenantAccess?: WorkspaceTenantAccessPort,
  ) {
    this.#store = store;
  }

  async requireExisting(id: string): Promise<Container> {
    const record = await this.#store.getContainer(id);
    if (!record) throw new HttpError(404, "container_not_found");
    return record;
  }

  async requireOwned(id: string, userId: string): Promise<Container> {
    const record = await this.requireExisting(id);
    if (record.userId !== userId) throw new HttpError(404, "container_not_found");
    if (this.tenantAccess) {
      try {
        await this.tenantAccess.requireWorkspaceAccess(id, userId);
      } catch (error) {
        // Tenant membership 失败不能泄露其他用户的 Workspace 是否存在；数据库等基础设施错误仍需向上抛出。
        if (!(error instanceof TenantMembershipError)) throw error;
        throw new HttpError(404, "container_not_found");
      }
    }
    return record;
  }
}
