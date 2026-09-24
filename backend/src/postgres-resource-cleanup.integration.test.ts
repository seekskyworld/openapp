import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { AppArtifact, AppVersion, BuildPackage, BuildStrategy, ImageBuild } from "./models.js";
import { PostgresPersistence } from "./persistence/postgres.js";

const { Pool } = pg;
const databaseUrl = process.env.POSTGRES_TEST_URL?.trim() ?? "";
const TEST_STRATEGY: BuildStrategy = {
  id: "postgres-cleanup",
  revision: 1,
  name: "PostgreSQL Cleanup",
  description: "",
  runtimeContract: "postgres-cleanup-v1",
  packageRequirements: [{ key: "backend", required: true, acceptedExtensions: [".tgz"] }],
  status: "active",
  createdAt: "2026-07-17T00:00:00.000Z",
  updatedAt: "2026-07-17T00:00:00.000Z",
};

test("PostgreSQL 17 migration and package cleanup races preserve JSON references", {
  skip: databaseUrl ? false : "POSTGRES_TEST_URL is required",
}, async (t) => {
  assert.ok(databaseUrl);
  const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
  const version = await bootstrap.query<{ server_version: string }>("show server_version");
  assert.match(version.rows[0]!.server_version, /^17\./u);
  const schema = `openapp_cleanup_${randomUUID().replaceAll("-", "")}`;
  await bootstrap.query(`create schema ${schema}`);
  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
  const control = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
  const persistence = new PostgresPersistence(scopedUrl.toString(), {
    strategyDefinitions: [TEST_STRATEGY],
  });
  t.after(async () => {
    await persistence.pool.end();
    await control.end();
    await bootstrap.query(`drop schema ${schema} cascade`);
    await bootstrap.end();
  });

  await persistence.initialize();
  await persistence.initialize();

  const migrated = await control.query<{ columnName: string }>(`
    select column_name as "columnName"
    from information_schema.columns
    where table_schema=current_schema()
      and (table_name,column_name) in (
        ('app_versions','revision'),
        ('app_versions','image_artifact_id'),
        ('containers','image_artifact_id'),
        ('containers','stop_reason'),
        ('build_packages','source_version'),
        ('build_packages','source_build_id'),
        ('build_packages','inspected_at')
      )
  `);
  assert.deepEqual(
    migrated.rows.map((row) => row.columnName).sort(),
    ["image_artifact_id", "image_artifact_id", "inspected_at", "revision", "source_build_id", "source_version", "stop_reason"],
  );

  const now = "2026-07-17T00:00:00.000Z";
  assert.ok(await persistence.createApp({
    id: "postgres-cleanup-race-app",
    name: "PostgreSQL Cleanup Race App",
    description: "",
    authAdapterId: "none",
    status: "active",
    createdAt: now,
    updatedAt: now,
  }));
  const strategy = await persistence.getBuildStrategy(TEST_STRATEGY.id);
  assert.ok(strategy);

  await testCreateBuildWins(persistence, control, strategy, now);
  await testDeleteWinsOverCreateBuild(persistence, control, strategy, now);
  await testSaveRevisionWins(persistence, control, now);
  await testDeleteWinsOverSaveRevision(persistence, control, now);

  const dangling = await control.query<{ count: string }>(`
    select count(*)::text as count from (
      select version.id
      from app_versions as version
      cross join lateral jsonb_array_elements(version.packages) as item
      left join build_packages as package on package.id=item->>'packageId'
      where item ? 'packageId' and package.id is null
      union all
      select build.id
      from image_builds as build
      cross join lateral jsonb_array_elements(build.packages) as item
      left join build_packages as package on package.id=item->>'packageId'
      where item ? 'packageId' and package.id is null
    ) as dangling_references
  `);
  assert.equal(Number(dangling.rows[0]!.count), 0);
});

async function testCreateBuildWins(
  persistence: PostgresPersistence,
  control: pg.Pool,
  strategy: BuildStrategy,
  now: string,
): Promise<void> {
  const pkg = buildPackage("package-create-build-wins", now);
  assert.ok(await persistence.createBuildPackage(pkg));
  const build = imageBuild("build-create-build-wins", pkg, strategy, now);
  const [created, deleted] = await runQueuedRace(
    control,
    pkg.id,
    () => persistence.createImageBuild(build),
    () => persistence.deleteBuildPackageIfUnreferenced(pkg.id),
  );
  assert.equal(created.status, "fulfilled");
  assert.equal(created.value?.id, build.id);
  assert.deepEqual(deleted, { status: "fulfilled", value: null });
  assert.ok(await persistence.getBuildPackage(pkg.id));
  assert.equal((await persistence.getImageBuild(build.id))?.packages[0]?.packageId, pkg.id);
}

async function testDeleteWinsOverCreateBuild(
  persistence: PostgresPersistence,
  control: pg.Pool,
  strategy: BuildStrategy,
  now: string,
): Promise<void> {
  const pkg = buildPackage("package-delete-wins-build", now);
  assert.ok(await persistence.createBuildPackage(pkg));
  const build = imageBuild("build-delete-loses", pkg, strategy, now);
  const [deleted, created] = await runQueuedRace(
    control,
    pkg.id,
    () => persistence.deleteBuildPackageIfUnreferenced(pkg.id),
    () => persistence.createImageBuild(build),
  );
  assert.equal(deleted.status, "fulfilled");
  assert.equal(deleted.value?.id, pkg.id);
  assert.equal(created.status, "rejected");
  assert.match(String(created.reason), /build_package_not_found/u);
  assert.equal(await persistence.getBuildPackage(pkg.id), null);
  assert.equal(await persistence.getImageBuild(build.id), null);
}

async function testSaveRevisionWins(
  persistence: PostgresPersistence,
  control: pg.Pool,
  now: string,
): Promise<void> {
  const pkg = buildPackage("package-save-revision-wins", now);
  assert.ok(await persistence.createBuildPackage(pkg));
  const version = appVersion("revision-save-wins", pkg, now);
  const [saved, deleted] = await runQueuedRace(
    control,
    pkg.id,
    () => persistence.saveAppVersion(version),
    () => persistence.deleteBuildPackageIfUnreferenced(pkg.id),
  );
  assert.equal(saved.status, "fulfilled");
  assert.equal(saved.value?.id, version.id);
  assert.deepEqual(deleted, { status: "fulfilled", value: null });
  assert.ok(await persistence.getBuildPackage(pkg.id));
  assert.equal((await persistence.getAppVersion(version.id))?.packages?.[0]?.packageId, pkg.id);
}

async function testDeleteWinsOverSaveRevision(
  persistence: PostgresPersistence,
  control: pg.Pool,
  now: string,
): Promise<void> {
  const pkg = buildPackage("package-delete-wins-revision", now);
  assert.ok(await persistence.createBuildPackage(pkg));
  const version = appVersion("revision-delete-loses", pkg, now);
  const [deleted, saved] = await runQueuedRace(
    control,
    pkg.id,
    () => persistence.deleteBuildPackageIfUnreferenced(pkg.id),
    () => persistence.saveAppVersion(version),
  );
  assert.equal(deleted.status, "fulfilled");
  assert.equal(deleted.value?.id, pkg.id);
  assert.equal(saved.status, "rejected");
  assert.match(String(saved.reason), /build_package_not_found/u);
  assert.equal(await persistence.getBuildPackage(pkg.id), null);
  assert.equal(await persistence.getAppVersion(version.id), null);
}

async function runQueuedRace<First, Second>(
  control: pg.Pool,
  packageId: string,
  firstOperation: () => Promise<First>,
  secondOperation: () => Promise<Second>,
): Promise<[PromiseSettledResult<First>, PromiseSettledResult<Second>]> {
  const blocker = await control.connect();
  const lockKey = `openapp:build-package:${packageId}`;
  let locked = false;
  try {
    await blocker.query("select pg_advisory_lock(hashtext($1))", [lockKey]);
    locked = true;
    const first = settle(firstOperation());
    await waitForAdvisoryWaiters(control, 1);
    const second = settle(secondOperation());
    await waitForAdvisoryWaiters(control, 2);
    await blocker.query("select pg_advisory_unlock(hashtext($1))", [lockKey]);
    locked = false;
    return [await first, await second];
  } finally {
    if (locked) await blocker.query("select pg_advisory_unlock(hashtext($1))", [lockKey]);
    blocker.release();
  }
}

async function waitForAdvisoryWaiters(control: pg.Pool, expected: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await control.query<{ count: string }>(`
      select count(*)::text as count
      from pg_stat_activity
      where datname=current_database()
        and wait_event_type='Lock'
        and lower(wait_event)='advisory'
        and query like 'select pg_advisory_xact_lock(hashtext($1))%'
    `);
    if (Number(result.rows[0]!.count) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`expected ${expected} queued package advisory lock waiter(s)`);
}

function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason }),
  );
}

function buildPackage(id: string, createdAt: string): BuildPackage {
  return {
    id,
    strategyId: TEST_STRATEGY.id,
    key: "backend",
    artifact: artifact(id),
    originalName: "backend.tgz",
    storageKey: `build-packages/${id}/backend.tgz`,
    uploadedBy: "postgres-test",
    createdAt,
  };
}

function imageBuild(id: string, pkg: BuildPackage, strategy: BuildStrategy, createdAt: string): ImageBuild {
  return {
    id,
    strategyId: strategy.id,
    strategySnapshot: strategy,
    operationId: null,
    sourceAppVersionId: null,
    requestedBy: "postgres-test",
    packages: [{ key: pkg.key, packageId: pkg.id, artifact: pkg.artifact }],
    status: "queued",
    error: null,
    createdAt,
    startedAt: null,
    finishedAt: null,
  };
}

function appVersion(id: string, pkg: BuildPackage, createdAt: string): AppVersion {
  return {
    id,
    appId: "postgres-cleanup-race-app",
    version: id,
    buildId: id,
    packages: [{ key: pkg.key, packageId: pkg.id, artifact: pkg.artifact }],
    imageReference: null,
    status: "uploaded",
    createdAt,
    activatedAt: null,
  };
}

function artifact(seed: string): AppArtifact {
  return {
    file: "backend.tgz",
    sha256: Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64),
    size: 1,
  };
}
