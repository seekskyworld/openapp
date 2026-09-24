import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { PostgresPersistence } from "./persistence/postgres.js";
import {
  WorkspaceExecutionGenerationRollbackError,
  WorkspaceExecutionProjectionError,
} from "./workspace-execution-model.js";

const { Pool } = pg;
const databaseUrl = process.env.POSTGRES_TEST_URL?.trim() ?? "";

test(
  "PostgreSQL 17 backfills and fences WorkspaceExecution compatibility state",
  {
    skip: databaseUrl ? false : "POSTGRES_TEST_URL is required",
  },
  async (t) => {
    assert.ok(databaseUrl);
    const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
    const version = await bootstrap.query<{ server_version: string }>("show server_version");
    assert.match(version.rows[0]!.server_version, /^17\./u);

    const schema = `openapp_execution_${randomUUID().replaceAll("-", "")}`;
    await bootstrap.query(`create schema ${schema}`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const control = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const firstPortal = new PostgresPersistence(scopedUrl.toString());
    const secondPortal = new PostgresPersistence(scopedUrl.toString());
    t.after(async () => {
      await Promise.all([firstPortal.pool.end(), secondPortal.pool.end(), control.end()]);
      await bootstrap.query(`drop schema ${schema} cascade`);
      await bootstrap.end();
    });

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
    const backfilled = await firstPortal.getWorkspaceExecutionProjection("legacy-workspace");
    assert.equal(backfilled?.workspace.storageRefId, "workspace-storage:legacy-workspace");
    assert.equal(backfilled?.execution.id, "legacy-workspace:docker");
    assert.equal(backfilled?.execution.environmentRef, "legacy-runtime");
    assert.equal(backfilled?.execution.healthyGeneration, 1);
    assert.equal((await secondPortal.getContainer("legacy-workspace"))?.imageReference, "sha256:legacy");

    const candidates = await Promise.all([
      firstPortal.compareAndSaveWorkspaceExecution(
        {
          ...structuredClone(backfilled!),
          execution: {
            ...structuredClone(backfilled!.execution),
            desiredGeneration: 3,
            deployedGeneration: 2,
            healthyGeneration: 2,
            transactionId: "postgres-generation-a",
          },
        },
        backfilled!.execution.revision,
      ),
      secondPortal.compareAndSaveWorkspaceExecution(
        {
          ...structuredClone(backfilled!),
          execution: {
            ...structuredClone(backfilled!.execution),
            desiredGeneration: 3,
            deployedGeneration: 2,
            healthyGeneration: 2,
            transactionId: "postgres-generation-b",
          },
        },
        backfilled!.execution.revision,
      ),
    ]);
    assert.equal(candidates.filter(Boolean).length, 1);
    const winner = candidates.find(Boolean)!;
    assert.equal(winner.execution.revision, 2);

    await assert.rejects(
      firstPortal.compareAndSaveWorkspaceExecution(
        {
          ...structuredClone(winner),
          execution: {
            ...structuredClone(winner.execution),
            desiredGeneration: 2,
          },
        },
        winner.execution.revision,
      ),
      WorkspaceExecutionGenerationRollbackError,
    );

    await control.query(
      `update containers set execution_image_reference='sha256:corrupt' where id='legacy-workspace'`,
    );
    await assert.rejects(firstPortal.getContainer("legacy-workspace"), WorkspaceExecutionProjectionError);
    await firstPortal.initialize();
    await assert.rejects(firstPortal.getContainer("legacy-workspace"), WorkspaceExecutionProjectionError);
    await control.query(
      `update containers set execution_image_reference=image_reference where id='legacy-workspace'`,
    );
    assert.equal((await firstPortal.getContainer("legacy-workspace"))?.id, "legacy-workspace");

    const active = (await firstPortal.getWorkspaceExecutionProjection("legacy-workspace"))!;
    const deleting = structuredClone(active);
    deleting.workspace.status = "deleting";
    deleting.workspace.deletionTransactionId = "postgres-delete-transaction";
    deleting.workspace.deletionPhase = "draining";
    deleting.workspace.deletionFailure = null;
    const persistedDeleting = await firstPortal.compareAndSaveWorkspaceExecution(
      deleting,
      active.execution.revision,
    );
    assert.equal(persistedDeleting?.workspace.status, "deleting");
    assert.equal(await secondPortal.getContainer("legacy-workspace"), null);
    assert.equal(
      (await secondPortal.getLiveWorkspaceExecutionForUser("legacy-owner"))?.workspace.status,
      "deleting",
    );
    assert.equal(
      await secondPortal.countLiveWorkspaceStorageReferences(
        "workspace-storage:legacy-workspace",
        "legacy-workspace",
      ),
      0,
    );

    const deleted = structuredClone(persistedDeleting!);
    deleted.workspace.status = "deleted";
    deleted.workspace.activeExecutionId = null;
    deleted.workspace.appRevisionId = null;
    deleted.workspace.deletionPhase = "deleted";
    deleted.workspace.deletedAt = "2026-08-04T01:00:00.000Z";
    deleted.execution.role = "retired";
    deleted.execution.environmentRef = null;
    deleted.execution.desiredState = "stopped";
    deleted.execution.observedState = "absent";
    deleted.execution.desiredAppRevisionId = null;
    deleted.execution.desiredLaunchArtifactId = null;
    deleted.execution.desiredLaunchArtifactReference = null;
    deleted.execution.launchArtifactId = null;
    deleted.execution.launchArtifactReference = null;
    deleted.execution.transactionStatus = "applied";
    deleted.execution.legacyEndpoint = null;
    deleted.execution.stopReason = null;
    deleted.execution.retiredAt = deleted.workspace.deletedAt;
    deleted.compatibility.runtimeId = "deleted";
    deleted.compatibility.status = "stopped";
    const tombstone = await firstPortal.compareAndSaveWorkspaceExecution(
      deleted,
      persistedDeleting!.execution.revision,
    );
    assert.equal(tombstone?.workspace.status, "deleted");
    assert.equal(
      (await secondPortal.getWorkspaceExecutionProjection("legacy-workspace"))?.workspace.deletedAt,
      "2026-08-04T01:00:00.000Z",
    );
    assert.equal(await secondPortal.getLiveWorkspaceExecutionForUser("legacy-owner"), null);

    await firstPortal.saveContainer({
      id: "replacement-workspace",
      userId: "legacy-owner",
      appId: "sample-app",
      runtimeId: "replacement-runtime",
      status: "stopped",
      endpoint: null,
      stopReason: "manual_user",
      createdAt: "2026-08-04T01:01:00.000Z",
      updatedAt: "2026-08-04T01:01:00.000Z",
      lastActivityAt: "2026-08-04T01:01:00.000Z",
      appVersionId: "legacy-release",
      imageArtifactId: null,
      imageReference: "sha256:legacy",
    });
    assert.equal((await secondPortal.getContainerForUser("legacy-owner"))?.id, "replacement-workspace");
  },
);
