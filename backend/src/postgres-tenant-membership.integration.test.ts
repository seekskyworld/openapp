import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import type { Container } from "./models.js";
import { PostgresPersistence } from "./persistence/postgres.js";
import { personalTenantId, TenantMembershipError, TenantMembershipService } from "./tenant-membership.js";

const { Pool } = pg;
const databaseUrl = process.env.POSTGRES_TEST_URL?.trim() ?? "";

test(
  "PostgreSQL tenant projection backfills legacy rows and remains idempotent",
  {
    skip: databaseUrl ? false : "POSTGRES_TEST_URL is required",
  },
  async (t) => {
    assert.ok(databaseUrl);
    const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
    const version = await bootstrap.query<{ server_version: string }>("show server_version");
    assert.match(version.rows[0]!.server_version, /^17\./u);

    const schema = `openapp_tenant_${randomUUID().replaceAll("-", "")}`;
    await bootstrap.query(`create schema ${schema}`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const control = new Pool({ connectionString: scopedUrl.toString(), max: 6 });
    const firstPortal = new PostgresPersistence(scopedUrl.toString());
    const secondPortal = new PostgresPersistence(scopedUrl.toString());
    t.after(async () => {
      await Promise.all([firstPortal.pool.end(), secondPortal.pool.end(), control.end()]);
      await bootstrap.query(`drop schema ${schema} cascade`);
      await bootstrap.end();
    });

    // 先建立最小的历史 schema，模拟升级前只有 User/Container 的数据库。
    await control.query(`
    create table users (
      id text primary key,
      email text unique not null,
      role text not null default 'user',
      created_at timestamptz not null default now(),
      app_initialized_at timestamptz
    );
    create table containers (
      id text primary key,
      user_id text unique not null references users(id) on delete cascade,
      app_id text not null default 'sample-app',
      runtime_id text not null,
      status text not null check (status in ('creating','running','stopped','failed')),
      endpoint text,
      stop_reason text check (stop_reason in ('idle','manual_user','manual_admin','failure')),
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      last_activity_at timestamptz not null default now(),
      app_version_id text,
      image_reference text,
      image_artifact_id text
    );
    insert into users(id,email) values('legacy-owner','legacy-owner@example.test');
    insert into containers(
      id,user_id,app_id,runtime_id,status,endpoint,created_at,updated_at,last_activity_at,
      app_version_id,image_reference,image_artifact_id
    ) values(
      'legacy-workspace','legacy-owner','sample-app','legacy-runtime','running',
      'http://legacy-workspace.test','2026-08-04T00:00:00Z','2026-08-04T00:00:00Z',
      '2026-08-04T00:00:00Z','legacy-release','sha256:legacy','legacy-artifact'
    );
  `);

    await firstPortal.initialize();
    await secondPortal.initialize();

    const legacy = await firstPortal.getContainer("legacy-workspace");
    assert.ok(legacy);
    assert.equal(legacy.imageArtifactId, "legacy-artifact");
    assert.equal(legacy.imageReference, "sha256:legacy");
    assert.equal(legacy.appVersionId, "legacy-release");
    const constraintValidated = async () => {
      const result = await control.query<{ convalidated: boolean }>(
        `select convalidated from pg_constraint
       where conrelid='containers'::regclass and conname='containers_image_artifact_id_fkey'`,
      );
      return result.rows[0]?.convalidated;
    };
    assert.equal(await constraintValidated(), false);
    // 旧实例仍可按原快照保存或改变运行状态，但不能引入新的悬空引用。
    await firstPortal.saveContainer(legacy);
    await firstPortal.updateContainer({ ...legacy, status: "stopped", endpoint: null });
    await assert.rejects(firstPortal.updateContainer({ ...legacy, imageArtifactId: "missing-artifact" }), {
      code: "23503",
    });
    assert.equal((await firstPortal.getContainer(legacy.id))?.imageArtifactId, "legacy-artifact");
    assert.equal((await control.query("select id from image_artifacts")).rowCount, 0);

    const tables = await control.query<{ relname: string }>(
      `select relname from pg_class
     where relnamespace=current_schema()::regnamespace
       and relkind='r' and relname = any($1::text[])`,
      [["tenants", "tenant_memberships", "workspace_tenant_bindings"]],
    );
    assert.deepEqual(tables.rows.map((row) => row.relname).sort(), [
      "tenant_memberships",
      "tenants",
      "workspace_tenant_bindings",
    ]);
    const indexes = await control.query<{ indexname: string }>(
      `select indexname from pg_indexes
     where schemaname=current_schema() and indexname = any($1::text[])`,
      [["tenant_memberships_user_idx", "workspace_tenant_bindings_tenant_idx"]],
    );
    assert.deepEqual(indexes.rows.map((row) => row.indexname).sort(), [
      "tenant_memberships_user_idx",
      "workspace_tenant_bindings_tenant_idx",
    ]);

    const backfilledTenant = await control.query<{ count: string }>(
      `select count(*)::text as count from tenants where id=$1 and kind='personal'`,
      [personalTenantId("legacy-owner")],
    );
    assert.equal(backfilledTenant.rows[0]?.count, "1");
    const backfilledMembership = await control.query<{ count: string }>(
      `select count(*)::text as count from tenant_memberships where tenant_id=$1 and user_id=$2 and role='owner'`,
      [personalTenantId("legacy-owner"), "legacy-owner"],
    );
    assert.equal(backfilledMembership.rows[0]?.count, "1");
    const backfilledBinding = await firstPortal.getWorkspaceTenantBinding("legacy-workspace");
    assert.equal(backfilledBinding?.tenantId, personalTenantId("legacy-owner"));
    assert.equal(backfilledBinding?.ownerId, "legacy-owner");

    const countsBefore = await projectionCounts(control);
    const tenantRowsBefore = await projectionTenantRows(control);
    await firstPortal.initialize();
    await secondPortal.initialize();
    assert.deepEqual(await projectionCounts(control), countsBefore);
    assert.deepEqual(await projectionTenantRows(control), tenantRowsBefore);

    const concurrentUser = await firstPortal.findOrCreateUser(
      "concurrent-owner@example.test",
      "concurrent-owner",
    );
    const tenantResults = await Promise.all([
      firstPortal.ensurePersonalTenant(concurrentUser.id),
      secondPortal.ensurePersonalTenant(concurrentUser.id),
      firstPortal.ensurePersonalTenant(concurrentUser.id),
    ]);
    assert.ok(tenantResults.every((result) => result.tenant.id === personalTenantId(concurrentUser.id)));
    const concurrentMemberships = await firstPortal.listTenantMemberships(concurrentUser.id);
    assert.equal(concurrentMemberships.length, 1);

    const workspace = postgresWorkspace("concurrent-workspace", concurrentUser.id);
    await assert.rejects(firstPortal.saveContainer({ ...workspace, imageArtifactId: "legacy-artifact" }), {
      code: "23503",
    });
    await firstPortal.saveContainer(workspace);
    const bindingResults = await Promise.all([
      firstPortal.bindWorkspaceToTenant(workspace.id, personalTenantId(concurrentUser.id), concurrentUser.id),
      secondPortal.bindWorkspaceToTenant(
        workspace.id,
        personalTenantId(concurrentUser.id),
        concurrentUser.id,
      ),
    ]);
    assert.ok(bindingResults.every((binding) => binding?.workspaceId === workspace.id));
    assert.equal(
      (await firstPortal.getWorkspaceTenantBinding(workspace.id))?.tenantId,
      personalTenantId(concurrentUser.id),
    );

    const outsider = await firstPortal.findOrCreateUser("tenant-outsider@example.test", "tenant-outsider");
    const service = new TenantMembershipService(firstPortal);
    await assert.rejects(
      service.requireWorkspaceAccess(workspace.id, outsider.id),
      (error: unknown) =>
        error instanceof TenantMembershipError && error.code === "tenant_membership_required",
    );

    await firstPortal.deleteContainer(workspace.id);
    assert.equal(await firstPortal.getWorkspaceTenantBinding(workspace.id), null);
    await firstPortal.deleteContainer(legacy.id);
    await firstPortal.initialize();
    await secondPortal.initialize();
    assert.equal(await constraintValidated(), true);
  },
);

async function projectionCounts(
  pool: pg.Pool,
): Promise<{ tenants: string; memberships: string; bindings: string }> {
  const result = await pool.query<{ tenants: string; memberships: string; bindings: string }>(
    `select
       (select count(*)::text from tenants) as tenants,
       (select count(*)::text from tenant_memberships) as memberships,
       (select count(*)::text from workspace_tenant_bindings) as bindings`,
  );
  return result.rows[0]!;
}

async function projectionTenantRows(pool: pg.Pool): Promise<
  Array<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  }>
> {
  const result = await pool.query<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  }>(
    `select id, name, created_at::text as "createdAt", updated_at::text as "updatedAt"
       from tenants order by id`,
  );
  return result.rows;
}

function postgresWorkspace(id: string, userId: string): Container {
  return {
    id,
    userId,
    appId: "sample-app",
    runtimeId: `${id}-runtime`,
    status: "stopped",
    endpoint: null,
    stopReason: "manual_user",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    lastActivityAt: "2026-08-05T00:00:00.000Z",
    appVersionId: "legacy-release",
    imageArtifactId: null,
    imageReference: "sha256:legacy",
  };
}
