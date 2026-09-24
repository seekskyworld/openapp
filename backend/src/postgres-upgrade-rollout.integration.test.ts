import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import type { BuildStrategy, Container, ImageBuild } from "./models.js";
import type { InstanceActivityLease, InstanceDrainRequest } from "./instance-upgrade-activity.js";
import { PostgresPersistence } from "./persistence/postgres.js";
import type { UpgradeRollout, UpgradeRolloutItem } from "./upgrade-rollouts.js";

const { Pool } = pg;
const databaseUrl = process.env.POSTGRES_TEST_URL?.trim() ?? "";
const TEST_STRATEGY: BuildStrategy = {
  id: "postgres-rollout",
  revision: 1,
  name: "PostgreSQL Rollout",
  description: "",
  runtimeContract: "postgres-rollout-v1",
  packageRequirements: [{ key: "bundle", required: true, acceptedExtensions: [".tar.gz"] }],
  status: "active",
  createdAt: "2026-07-23T00:00:00.000Z",
  updatedAt: "2026-07-23T00:00:00.000Z",
};

test(
  "PostgreSQL 17 coordinates upgrade rollouts across Portal processes",
  {
    skip: databaseUrl ? false : "POSTGRES_TEST_URL is required",
  },
  async (t) => {
    assert.ok(databaseUrl);
    const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
    const version = await bootstrap.query<{ server_version: string }>("show server_version");
    assert.match(version.rows[0]!.server_version, /^17\./u);

    const schema = `openapp_rollout_${randomUUID().replaceAll("-", "")}`;
    await bootstrap.query(`create schema ${schema}`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const control = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
    const firstPortal = new PostgresPersistence(scopedUrl.toString(), {
      strategyDefinitions: [TEST_STRATEGY],
    });
    const secondPortal = new PostgresPersistence(scopedUrl.toString(), {
      strategyDefinitions: [TEST_STRATEGY],
    });
    t.after(async () => {
      await Promise.all([firstPortal.pool.end(), secondPortal.pool.end(), control.end()]);
      await bootstrap.query(`drop schema ${schema} cascade`);
      await bootstrap.end();
    });

    await firstPortal.initialize();
    await secondPortal.initialize();

    const sourceBuild: ImageBuild = {
      id: "postgres-source-build",
      strategyId: TEST_STRATEGY.id,
      strategySnapshot: TEST_STRATEGY,
      operationId: null,
      sourceAppVersionId: null,
      requestedBy: "postgres-rollout-test",
      packages: [],
      status: "building",
      error: null,
      createdAt: TEST_STRATEGY.createdAt,
      startedAt: TEST_STRATEGY.createdAt,
      finishedAt: null,
    };
    assert.ok(await firstPortal.createImageBuild(sourceBuild));
    assert.ok(
      await firstPortal.completeImageBuild(
        { ...sourceBuild, status: "succeeded", finishedAt: TEST_STRATEGY.createdAt },
        {
          id: "postgres-source-artifact",
          buildId: sourceBuild.id,
          imageReference: `sha256:${"a".repeat(64)}`,
          imageId: `sha256:${"a".repeat(64)}`,
          runtimeContract: TEST_STRATEGY.runtimeContract,
          createdAt: TEST_STRATEGY.createdAt,
        },
        "building",
      ),
    );

    await t.test("upgrades the legacy v2 rollout constraint and due index", async () => {
      await control.query(`
      alter table upgrade_rollout_items drop constraint upgrade_rollout_items_status_check_v3;
      alter table upgrade_rollout_items add constraint upgrade_rollout_items_status_check_v2
        check (status in ('queued','assessing','waiting_for_idle','draining','rebuilding','verifying','succeeded','failed','cancelled','needs_attention'));
      drop index upgrade_rollout_items_due_v3_idx;
      create index upgrade_rollout_items_due_v2_idx
        on upgrade_rollout_items(next_attempt_at,position)
        where status in ('queued','waiting_for_idle');
    `);

      await firstPortal.initialize();

      const constraint = await control.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid='upgrade_rollout_items'::regclass and conname='upgrade_rollout_items_status_check_v3'`,
      );
      assert.match(constraint.rows[0]?.definition ?? "", /awaiting_first_start/u);
      const indexes = await control.query<{ indexname: string; indexdef: string }>(
        `select indexname,indexdef from pg_indexes
       where schemaname=current_schema() and tablename='upgrade_rollout_items'
         and indexname like 'upgrade_rollout_items_due_%'`,
      );
      assert.deepEqual(
        indexes.rows.map((row) => row.indexname),
        ["upgrade_rollout_items_due_v3_idx"],
      );
      assert.match(indexes.rows[0]?.indexdef ?? "", /awaiting_first_start/u);

      await control.query(
        "alter table upgrade_rollouts drop constraint upgrade_rollouts_task_kind_check; alter table upgrade_rollouts drop column task_kind;",
      );
      await firstPortal.initialize();
      const taskKind = await control.query<{ column_default: string; is_nullable: string }>(
        `select column_default,is_nullable from information_schema.columns
       where table_schema=current_schema() and table_name='upgrade_rollouts' and column_name='task_kind'`,
      );
      assert.equal(taskKind.rows[0]?.column_default, "'image_upgrade'::text");
      assert.equal(taskKind.rows[0]?.is_nullable, "NO");
      const taskKindConstraint = await control.query<{ definition: string }>(
        `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid='upgrade_rollouts'::regclass and conname='upgrade_rollouts_task_kind_check'`,
      );
      assert.match(taskKindConstraint.rows[0]?.definition ?? "", /instance_recovery/u);
    });

    await t.test("persists rollout queries, single-winner CAS, and interrupted recovery", async () => {
      const now = "2026-07-23T00:00:00.000Z";
      const user = await firstPortal.findOrCreateUser(
        "rollout-postgres@example.test",
        "rollout-postgres-user",
      );
      const instance = containerFixture("rollout-postgres-instance", user.id, now);
      await firstPortal.saveContainer(instance);

      const rollout = rolloutFixture("rollout-postgres", now);
      const item = {
        ...itemFixture(rollout.id, instance, now),
        recovery: true,
        diagnostics: {
          capturedAt: now,
          error: "runtime_failure",
          exitCode: 137,
          oomKilled: true,
          logTail: "bounded log tail",
        },
      };
      const created = await firstPortal.createUpgradeRollout(rollout, [item]);
      assert.deepEqual(created, { rollout, items: [item] });
      assert.equal(
        (await secondPortal.findUpgradeRolloutByIdempotencyKey(rollout.actorUserId, rollout.idempotencyKey!))
          ?.rollout.id,
        rollout.id,
      );
      assert.equal((await secondPortal.getUpgradeRollout(rollout.id))?.items[0]?.instanceId, instance.id);
      assert.deepEqual(
        (await secondPortal.listUpgradeRollouts(1)).map((value) => value.id),
        [rollout.id],
      );
      assert.deepEqual(
        (await secondPortal.listDueUpgradeRolloutItems(now, 10)).map((value) => value.instanceId),
        [instance.id],
      );
      assert.equal((await secondPortal.listDueUpgradeRolloutItems("2026-07-22T23:59:59.999Z", 10)).length, 0);

      const idempotent = await secondPortal.createUpgradeRollout(
        { ...rollout, id: "ignored-rollout-id" },
        [],
      );
      assert.equal(idempotent.rollout.id, rollout.id);
      assert.equal(idempotent.items.length, 1);

      const conflictingRollout = {
        ...rolloutFixture("rollout-postgres-conflict", now),
        idempotencyKey: "rollout-postgres-conflict-key",
      };
      const queuedRollout = await secondPortal.createUpgradeRollout(conflictingRollout, [
        {
          ...item,
          rolloutId: conflictingRollout.id,
        },
      ]);
      assert.equal(queuedRollout.rollout.id, conflictingRollout.id);

      const itemUpdates = await Promise.all([
        firstPortal.compareAndSaveUpgradeRolloutItem(
          {
            ...item,
            status: "waiting_for_idle",
            blocker: "active_http",
            updatedAt: "2026-07-23T00:00:01.000Z",
          },
          item.revision,
        ),
        secondPortal.compareAndSaveUpgradeRolloutItem(
          {
            ...item,
            status: "waiting_for_idle",
            blocker: "active_websocket",
            updatedAt: "2026-07-23T00:00:02.000Z",
          },
          item.revision,
        ),
      ]);
      assert.equal(itemUpdates.filter(Boolean).length, 1);
      assert.equal(itemUpdates.find(Boolean)?.revision, 2);

      const rolloutUpdates = await Promise.all([
        firstPortal.compareAndSaveUpgradeRollout(
          {
            ...rollout,
            waiting: 1,
            updatedAt: "2026-07-23T00:00:01.000Z",
          },
          rollout.revision,
        ),
        secondPortal.compareAndSaveUpgradeRollout(
          {
            ...rollout,
            upgrading: 1,
            updatedAt: "2026-07-23T00:00:02.000Z",
          },
          rollout.revision,
        ),
      ]);
      assert.equal(rolloutUpdates.filter(Boolean).length, 1);
      assert.equal(rolloutUpdates.find(Boolean)?.revision, 2);

      const recoveryTime = "2026-07-23T00:20:00.000Z";
      const interruptedUser = await firstPortal.findOrCreateUser(
        "rollout-interrupted@example.test",
        "rollout-interrupted-user",
      );
      const interruptedInstance = containerFixture("rollout-interrupted-instance", interruptedUser.id, now);
      await firstPortal.saveContainer(interruptedInstance);
      const interruptedRollout = rolloutFixture("rollout-interrupted", now);
      const interruptedItem = {
        ...itemFixture(interruptedRollout.id, interruptedInstance, now),
        status: "rebuilding" as const,
        attemptId: "attempt-interrupted",
        attemptCount: 1,
        nextAttemptAt: null,
        startedAt: now,
      };
      await firstPortal.createUpgradeRollout(interruptedRollout, [interruptedItem]);
      assert.equal(
        await firstPortal.beginInstanceDraining(
          drainRequest({
            instanceId: instance.id,
            rolloutId: interruptedRollout.id,
            attemptId: interruptedItem.attemptId,
            at: now,
          }),
        ),
        true,
      );

      assert.equal(
        await secondPortal.recoverInterruptedUpgradeRolloutItems("2026-07-23T00:10:00.000Z", recoveryTime),
        1,
      );
      const recovered = (await firstPortal.getUpgradeRollout(interruptedRollout.id))?.items[0];
      assert.equal(recovered?.status, "awaiting_first_start");
      assert.equal(recovered?.blocker, "candidate_recovery_pending");
      assert.equal(recovered?.attemptId, "attempt-interrupted");
      assert.equal(recovered?.nextAttemptAt, recoveryTime);
      assert.equal(recovered?.revision, 2);
      assert.equal(await firstPortal.isInstanceDraining(interruptedInstance.id, recoveryTime), false);
    });

    await t.test(
      "atomically supersedes a legacy missing-proof item at the next deployment checkpoint",
      async () => {
        const oldCreatedAt = "2026-07-23T00:25:00.000Z";
        const checkpointAt = "2026-07-23T00:26:00.000Z";
        const user = await firstPortal.findOrCreateUser(
          "proof-checkpoint@example.test",
          "proof-checkpoint-user",
        );
        const instance = {
          ...containerFixture("proof-checkpoint-instance", user.id, oldCreatedAt),
          status: "stopped" as const,
        };
        await firstPortal.saveContainer(instance);

        const olderRollout = rolloutFixture("rollout-proof-older", oldCreatedAt);
        const olderItem: UpgradeRolloutItem = {
          ...itemFixture(olderRollout.id, instance, oldCreatedAt),
          status: "needs_attention",
          blocker: "candidate_first_start_proof_missing",
          error: "candidate_first_start_proof_missing",
          attemptCount: 1,
          nextAttemptAt: null,
          finishedAt: checkpointAt,
        };
        await firstPortal.createUpgradeRollout(olderRollout, [olderItem]);

        const newerRollout = {
          ...rolloutFixture("rollout-proof-newer", checkpointAt),
          idempotencyKey: "rollout-proof-newer-key",
        };
        const newerItem: UpgradeRolloutItem = {
          ...itemFixture(newerRollout.id, instance, checkpointAt),
          createdAt: checkpointAt,
          updatedAt: checkpointAt,
          sourceAppVersionId: olderItem.targetAppVersionId,
          sourceImageArtifactId: olderItem.targetImageArtifactId,
          sourceImageReference: olderItem.targetImageReference,
          targetAppVersionId: "postgres-newer-target-version",
          targetImageArtifactId: "postgres-newer-target-artifact",
          targetImageReference: `sha256:${"d".repeat(64)}`,
          launchProfile: {
            ...olderItem.launchProfile,
            imageReference: `sha256:${"d".repeat(64)}`,
          },
          status: "awaiting_first_start",
          blocker: "candidate_awaiting_first_healthy_start",
          attemptId: "proof-checkpoint-attempt",
          nextAttemptAt: checkpointAt,
        };
        await firstPortal.createUpgradeRollout(newerRollout, [newerItem]);

        const committed = await secondPortal.commitUpgradeDeploymentCheckpoint(
          newerItem,
          newerItem.revision,
          checkpointAt,
          true,
        );
        assert.ok(committed);
        const older = await firstPortal.getUpgradeRollout(olderRollout.id);
        assert.equal(older?.items[0]?.status, "superseded");
        assert.equal(older?.items[0]?.blocker, "superseded_by_newer_deployment");
        assert.equal(older?.items[0]?.error, null);
        assert.notEqual(older?.items[0]?.targetAppVersionId, newerItem.targetAppVersionId);
      },
    );

    await t.test("legacy proof scan only returns image-upgrade items", async () => {
      const createdAt = "2026-07-23T00:27:00.000Z";
      const user = await firstPortal.findOrCreateUser("proof-scan@example.test", "proof-scan-user");
      const instance = {
        ...containerFixture("proof-scan-instance", user.id, createdAt),
        status: "stopped" as const,
      };
      await firstPortal.saveContainer(instance);

      const imageRollout = rolloutFixture("rollout-proof-scan-image", createdAt);
      const imageItem: UpgradeRolloutItem = {
        ...itemFixture(imageRollout.id, instance, createdAt),
        status: "needs_attention",
        blocker: "candidate_first_start_proof_missing",
        error: "candidate_first_start_proof_missing",
        attemptCount: 1,
        nextAttemptAt: null,
        finishedAt: createdAt,
      };
      await firstPortal.createUpgradeRollout(imageRollout, [imageItem]);

      const maintenanceRollout = {
        ...rolloutFixture("rollout-proof-scan-maintenance", createdAt),
        taskKind: "rebuild_same_image" as const,
        useLatestVersion: false,
      };
      const maintenanceItem: UpgradeRolloutItem = {
        ...itemFixture(maintenanceRollout.id, instance, createdAt),
        status: "needs_attention",
        blocker: "candidate_first_start_proof_missing",
        error: "candidate_first_start_proof_missing",
        attemptCount: 1,
        nextAttemptAt: null,
        finishedAt: createdAt,
      };
      await firstPortal.createUpgradeRollout(maintenanceRollout, [maintenanceItem]);

      const legacy = await secondPortal.listLegacyFirstStartProofItems!();
      assert.deepEqual(
        legacy.map((item) => item.rolloutId),
        [imageRollout.id],
      );
      const scanned = legacy[0]!;
      const competingUpdates = await Promise.all([
        firstPortal.compareAndSaveUpgradeRolloutItem(
          {
            ...scanned,
            status: "awaiting_first_start",
            blocker: "candidate_awaiting_first_healthy_start",
            error: null,
            attemptId: "proof-scan-revalidate",
            attemptCount: 0,
            nextAttemptAt: "2026-07-23T00:27:01.000Z",
            updatedAt: "2026-07-23T00:27:01.000Z",
          },
          scanned.revision,
        ),
        secondPortal.compareAndSaveUpgradeRolloutItem(
          {
            ...scanned,
            status: "cancelled",
            blocker: null,
            error: null,
            attemptId: null,
            nextAttemptAt: null,
            finishedAt: "2026-07-23T00:27:02.000Z",
            updatedAt: "2026-07-23T00:27:02.000Z",
          },
          scanned.revision,
        ),
      ]);
      assert.equal(competingUpdates.filter(Boolean).length, 1);
      const persisted = await firstPortal.getUpgradeRollout(imageRollout.id);
      assert.ok(["awaiting_first_start", "cancelled"].includes(persisted?.items[0]?.status ?? ""));
    });

    await t.test(
      "protects resumable rollout targets and releases only succeeded or cancelled targets",
      async () => {
        const now = "2026-07-23T00:30:00.000Z";
        const strategy = await firstPortal.getBuildStrategy(TEST_STRATEGY.id);
        assert.ok(strategy);
        const build: ImageBuild = {
          id: "target-reference-build",
          strategyId: strategy.id,
          strategySnapshot: strategy,
          operationId: null,
          sourceAppVersionId: null,
          requestedBy: "postgres-rollout-test",
          packages: [],
          status: "building",
          error: null,
          createdAt: now,
          startedAt: now,
          finishedAt: null,
        };
        assert.ok(await firstPortal.createImageBuild(build));
        const artifact = {
          id: "target-reference-artifact",
          buildId: build.id,
          imageReference: "target-reference:latest",
          imageId: `sha256:${"c".repeat(64)}`,
          runtimeContract: strategy.runtimeContract,
          createdAt: now,
        };
        assert.ok(
          await firstPortal.completeImageBuild(
            { ...build, status: "succeeded", finishedAt: now },
            artifact,
            "building",
          ),
        );

        const statuses = [
          "queued",
          "assessing",
          "waiting_for_idle",
          "draining",
          "rebuilding",
          "verifying",
          "awaiting_first_start",
          "failed",
          "needs_attention",
          "succeeded",
          "cancelled",
        ] as const;
        const createdItems: UpgradeRolloutItem[] = [];
        for (const [position, status] of statuses.entries()) {
          const statusUser = await firstPortal.findOrCreateUser(
            `target-reference-${status}@example.test`,
            `target-reference-user-${status}`,
          );
          const instance = containerFixture(`target-reference-instance-${status}`, statusUser.id, now);
          await firstPortal.saveContainer(instance);
          const rollout = rolloutFixture(`rollout-target-reference-${status}`, now);
          const baseItem = itemFixture(rollout.id, instance, now);
          const item: UpgradeRolloutItem = {
            ...baseItem,
            position,
            sourceImageArtifactId: status === "failed" ? artifact.id : baseItem.sourceImageArtifactId,
            sourceImageReference: status === "failed" ? artifact.imageId : baseItem.sourceImageReference,
            targetImageArtifactId: `other-artifact-${status}`,
            targetImageReference: `other-image:${status}`,
            launchProfile: {
              ...baseItem.launchProfile,
              imageReference: `other-image:${status}`,
            },
            status,
          };
          await firstPortal.createUpgradeRollout(rollout, [item]);
          createdItems.push(item);
        }

        const references = (await secondPortal.listActiveUpgradeRolloutTargetReferences()).filter(
          (reference) => reference.rolloutId.startsWith("rollout-target-reference-"),
        );
        assert.deepEqual(
          references.map((reference) => reference.status).sort(),
          statuses.filter((status) => status !== "succeeded" && status !== "cancelled").sort(),
        );
        assert.equal(await secondPortal.deleteImageArtifactIfUnreferenced(artifact.id), null);

        const failedItem = createdItems.find((item) => item.status === "failed");
        assert.ok(failedItem);
        assert.ok(
          await firstPortal.compareAndSaveUpgradeRolloutItem(
            {
              ...failedItem,
              status: "cancelled",
              updatedAt: "2026-07-23T00:30:01.000Z",
              finishedAt: "2026-07-23T00:30:01.000Z",
            },
            failedItem.revision,
          ),
        );
        assert.equal((await secondPortal.deleteImageArtifactIfUnreferenced(artifact.id))?.id, artifact.id);
      },
    );

    await t.test("serializes activity admission and fences drain cleanup by attempt", async () => {
      const now = "2026-07-23T01:00:00.000Z";
      const user = await firstPortal.findOrCreateUser(
        "activity-postgres@example.test",
        "activity-postgres-user",
      );
      const instance = containerFixture("activity-postgres-instance", user.id, now);
      await firstPortal.saveContainer(instance);
      const rollout = rolloutFixture("rollout-activity", now);
      await firstPortal.createUpgradeRollout(rollout, [itemFixture(rollout.id, instance, now)]);

      const lease: InstanceActivityLease = {
        id: "activity-race-lease",
        instanceId: instance.id,
        kind: "http",
        openedAt: now,
        heartbeatAt: now,
        lastActivityAt: now,
      };
      const drain = drainRequest({
        instanceId: instance.id,
        rolloutId: rollout.id,
        attemptId: "attempt-current",
        at: now,
      });
      const [opened, draining] = await Promise.all([
        firstPortal.tryOpenInstanceActivityLease(lease, now),
        secondPortal.beginInstanceDraining(drain),
      ]);
      assert.deepEqual([opened, draining].sort(), [false, true]);

      if (opened) {
        await firstPortal.deleteInstanceActivityLease(lease.id);
        assert.equal(await secondPortal.beginInstanceDraining(drain), true);
      }
      assert.equal(
        await firstPortal.tryOpenInstanceActivityLease({ ...lease, id: "activity-blocked-lease" }, now),
        false,
      );

      await secondPortal.clearInstanceDraining(instance.id, rollout.id, "attempt-stale");
      assert.equal(await firstPortal.isInstanceDraining(instance.id, now), true);
      await secondPortal.clearInstanceDraining(instance.id, rollout.id, drain.attemptId);
      assert.equal(await firstPortal.isInstanceDraining(instance.id, now), false);
      assert.equal(
        await firstPortal.tryOpenInstanceActivityLease({ ...lease, id: "activity-after-drain" }, now),
        true,
      );
    });

    await t.test("holds and releases maintenance leases across Portal processes", async () => {
      let signalStarted!: () => void;
      let releaseFirst!: () => void;
      const started = new Promise<void>((resolve) => {
        signalStarted = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = firstPortal.withMaintenanceLease("rollout-worker", async (signal) => {
        assert.equal(signal.aborted, false);
        signalStarted();
        await release;
        return "first-portal";
      });
      await started;

      assert.equal(
        await secondPortal.withMaintenanceLease("rollout-worker", async () => "second-portal"),
        null,
      );
      const waited = secondPortal.withMaintenanceLease("rollout-worker", async () => "waited-second-portal", {
        waitMs: 500,
        retryDelayMs: 5,
      });
      setTimeout(releaseFirst, 20).unref();
      assert.equal(await waited, "waited-second-portal");
      assert.equal(await first, "first-portal");
      assert.equal(
        await secondPortal.withMaintenanceLease("rollout-worker", async (signal) => {
          assert.equal(signal.aborted, false);
          return "second-portal";
        }),
        "second-portal",
      );
    });
  },
);

function rolloutFixture(id: string, createdAt: string): UpgradeRollout {
  return {
    id,
    revision: 1,
    actorUserId: "postgres-rollout-admin",
    status: "running",
    taskKind: "image_upgrade",
    useLatestVersion: true,
    requested: 1,
    completed: 0,
    succeeded: 0,
    failed: 0,
    waiting: 0,
    upgrading: 0,
    needsAttention: 0,
    idempotencyKey: `${id}-idempotency`,
    requestFingerprint: `${id}-fingerprint`,
    createdAt,
    updatedAt: createdAt,
    finishedAt: null,
  };
}

function itemFixture(rolloutId: string, instance: Container, createdAt: string): UpgradeRolloutItem {
  const targetImageReference = `sha256:${"b".repeat(64)}`;
  return {
    rolloutId,
    instanceId: instance.id,
    position: 0,
    revision: 1,
    userId: instance.userId,
    appId: instance.appId,
    sourceStatus: instance.status,
    desiredState: instance.status === "stopped" ? "stopped" : "running",
    sourceAppVersionId: instance.appVersionId ?? null,
    sourceImageArtifactId: instance.imageArtifactId ?? null,
    sourceImageReference: instance.imageReference ?? null,
    targetAppVersionId: "postgres-target-version",
    targetImageArtifactId: "postgres-target-artifact",
    targetImageReference,
    targetRuntimeContract: TEST_STRATEGY.runtimeContract,
    launchProfile: {
      imageReference: targetImageReference,
      resources: { memory: "4g", cpus: "2", pidsLimit: 512 },
      environment: {},
      configFiles: [],
    },
    status: "queued",
    blocker: null,
    error: null,
    forceRequested: false,
    attemptId: null,
    attemptCount: 0,
    nextAttemptAt: createdAt,
    lastCheckedAt: null,
    startedAt: null,
    finishedAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

function containerFixture(id: string, userId: string, createdAt: string): Container {
  return {
    id,
    userId,
    appId: "postgres-rollout-app",
    runtimeId: `${id}-runtime`,
    status: "running",
    endpoint: "http://127.0.0.1:3000",
    stopReason: null,
    createdAt,
    updatedAt: createdAt,
    lastActivityAt: createdAt,
    appVersionId: "postgres-source-version",
    imageArtifactId: "postgres-source-artifact",
    imageReference: `sha256:${"a".repeat(64)}`,
  };
}

function drainRequest(input: {
  instanceId: string;
  rolloutId: string;
  attemptId: string;
  at: string;
}): InstanceDrainRequest {
  return {
    ...input,
    expiresAt: "2026-07-23T02:00:00.000Z",
    heartbeatCutoff: "2026-07-22T23:00:00.000Z",
    websocketActivityCutoff: "2026-07-22T23:00:00.000Z",
    mode: "graceful",
  };
}
