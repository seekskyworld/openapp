import assert from "node:assert/strict";
import test from "node:test";

import { HttpError } from "./http-response.js";
import type { Container, Tenant, TenantMembership, WorkspaceTenantBinding } from "./models.js";
import { MemoryPersistence } from "./persistence/memory.js";
import {
  personalTenantId,
  TenantMembershipError,
  TenantMembershipService,
  type WorkspaceTenantAccessPort,
} from "./tenant-membership.js";
import { WorkspaceAuthorizationService } from "./workspace-authorization.js";

test("Personal Tenant identity is deterministic and idempotent under concurrent access", async () => {
  const persistence = new MemoryPersistence();
  const user = await persistence.findOrCreateUser("tenant-owner@example.test", "tenant-owner");
  const service = new TenantMembershipService(persistence);

  const results = await Promise.all(
    Array.from({ length: 16 }, () => service.ensurePersonalTenant(user.id)),
  );

  assert.ok(results.every((result) => result.tenant.id === personalTenantId(user.id)));
  assert.ok(results.every((result) => result.membership.role === "owner"));
  assert.equal((await persistence.listTenantMemberships(user.id)).length, 1);
  assert.equal((await persistence.listTenantMemberships(user.id))[0]?.tenant.id, personalTenantId(user.id));
});

test("a legacy Workspace is lazily bound without changing its public identity", async () => {
  const persistence = new MemoryPersistence();
  const user = await persistence.findOrCreateUser("legacy-owner@example.test", "legacy-owner");
  const workspace = legacyWorkspace("legacy-workspace", user.id);
  await persistence.saveContainer(workspace);
  const service = new TenantMembershipService(persistence);

  const first = await service.requireWorkspaceAccess(workspace.id, user.id);
  const second = await service.requireWorkspaceAccess(workspace.id, user.id);

  assert.equal(first.workspaceId, workspace.id);
  assert.deepEqual(second, first);
  assert.deepEqual(await persistence.getContainer(workspace.id), workspace);
  assert.equal(first.tenantId, personalTenantId(user.id));
});

test("a Workspace binding conflict fails closed and does not cross user boundaries", async () => {
  const persistence = new MemoryPersistence();
  const owner = await persistence.findOrCreateUser("binding-owner@example.test", "binding-owner");
  const other = await persistence.findOrCreateUser("binding-other@example.test", "binding-other");
  const workspace = legacyWorkspace("bound-workspace", owner.id);
  await persistence.saveContainer(workspace);
  const service = new TenantMembershipService(persistence);
  await service.ensureWorkspaceBinding(workspace.id, owner.id);

  await assert.rejects(
    service.ensureWorkspaceBinding(workspace.id, other.id),
    (error: unknown) => error instanceof TenantMembershipError
      && error.code === "tenant_workspace_binding_conflict",
  );
  await assert.rejects(
    service.requireWorkspaceAccess(workspace.id, other.id),
    (error: unknown) => error instanceof TenantMembershipError
      && error.code === "tenant_membership_required",
  );

  const authorization = new WorkspaceAuthorizationService(persistence, service);
  await assert.rejects(
    authorization.requireOwned(workspace.id, other.id),
    (error: unknown) => error instanceof HttpError
      && error.status === 404
      && error.message === "container_not_found",
  );
});

test("only owner or admin membership can establish a binding, while a member can access an existing one", async () => {
  const tenant: Tenant = {
    id: "organization:test",
    kind: "organization",
    name: "Test Organization",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
  const member: TenantMembership = {
    tenantId: tenant.id,
    userId: "member-id",
    role: "member",
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
  const binding: WorkspaceTenantBinding = {
    workspaceId: "organization-workspace",
    tenantId: tenant.id,
    ownerId: "owner-id",
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
  const accessPort: WorkspaceTenantAccessPort = new TenantMembershipService({
    ensurePersonalTenant: async () => ({ tenant, membership: member }),
    listTenantMemberships: async (userId) => userId === member.userId ? [{ tenant, membership: member }] : [],
    getWorkspaceTenantBinding: async () => binding,
    bindWorkspaceToTenant: async () => null,
  });

  await assert.rejects(
    accessPort.ensureWorkspaceBinding(binding.workspaceId, member.userId),
    (error: unknown) => error instanceof TenantMembershipError
      && error.code === "tenant_membership_required",
  );
  assert.deepEqual(await accessPort.requireWorkspaceAccess(binding.workspaceId, member.userId), binding);
});

test("authorization preserves infrastructure errors instead of mapping them to not-found", async () => {
  const workspace = legacyWorkspace("infra-workspace", "infra-owner");
  const failingAccess: WorkspaceTenantAccessPort = {
    ensureWorkspaceBinding: async () => { throw new Error("database_unavailable"); },
    requireWorkspaceAccess: async () => { throw new Error("database_unavailable"); },
  };
  const authorization = new WorkspaceAuthorizationService(
    { getContainer: async () => workspace },
    failingAccess,
  );

  await assert.rejects(
    authorization.requireOwned(workspace.id, workspace.userId),
    (error: unknown) => error instanceof Error && error.message === "database_unavailable",
  );
});

test("deleting a Workspace removes its compatibility binding", async () => {
  const persistence = new MemoryPersistence();
  const user = await persistence.findOrCreateUser("delete-owner@example.test", "delete-owner");
  const workspace = legacyWorkspace("delete-workspace", user.id);
  await persistence.saveContainer(workspace);
  const service = new TenantMembershipService(persistence);
  await service.ensureWorkspaceBinding(workspace.id, user.id);

  await persistence.deleteContainer(workspace.id);

  assert.equal(await persistence.getWorkspaceTenantBinding(workspace.id), null);
});

function legacyWorkspace(id: string, userId: string): Container {
  return {
    id,
    userId,
    appId: "sample-app",
    runtimeId: `${id}-runtime`,
    status: "running",
    endpoint: `http://${id}.example.test`,
    stopReason: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    lastActivityAt: "2026-08-01T00:00:00.000Z",
    appVersionId: "legacy-version",
    imageArtifactId: "legacy-artifact",
    imageReference: "sha256:legacy",
  };
}
