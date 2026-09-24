import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

import { UserRoleUpdateError, type User } from "./models.js";
import { PostgresPersistence } from "./persistence/postgres.js";

const { Pool } = pg;
const databaseUrl = process.env.POSTGRES_TEST_URL?.trim() ?? "";

test("PostgreSQL serializes super-administrator governance and reauthorizes actors", {
  skip: databaseUrl ? false : "POSTGRES_TEST_URL is required",
}, async (t) => {
  assert.ok(databaseUrl);
  const bootstrap = new Pool({ connectionString: databaseUrl, max: 1 });
  const version = await bootstrap.query<{ server_version: string }>("show server_version");
  assert.match(version.rows[0]!.server_version, /^17\./u);

  const schema = `openapp_roles_${randomUUID().replaceAll("-", "")}`;
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

  await firstPortal.initialize();
  await secondPortal.initialize();
  const roleConstraint = await control.query<{ definition: string }>(`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid='users'::regclass and conname='users_role_check'
  `);
  assert.match(roleConstraint.rows[0]?.definition ?? "", /super_admin/u);

  const first = await seedManagementUser(control, "first-super@example.test", "hash-first", "super_admin");
  const second = await seedManagementUser(control, "second-super@example.test", "hash-second", "super_admin");

  const crossDemotions = await Promise.allSettled([
    firstPortal.changeUserRole({
      actorUserId: first.id,
      targetUserId: second.id,
      expectedRole: "super_admin",
      role: "admin",
    }),
    secondPortal.changeUserRole({
      actorUserId: second.id,
      targetUserId: first.id,
      expectedRole: "super_admin",
      role: "admin",
    }),
  ]);
  assert.equal(crossDemotions.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = crossDemotions.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof UserRoleUpdateError);
  assert.equal(rejected.reason.code, "super_admin_required");
  const usersAfterRace = await firstPortal.listUsers();
  const remainingSuperAdmin = usersAfterRace.find((user) => user.role === "super_admin");
  const demotedAdmin = usersAfterRace.find((user) => user.role === "admin");
  assert.ok(remainingSuperAdmin);
  assert.ok(demotedAdmin);
  assert.equal(usersAfterRace.filter((user) => user.role === "super_admin").length, 1);

  const member = await firstPortal.createManagedLocalUser({
    actorUserId: demotedAdmin.id,
    email: "member-created-by-admin@example.test",
    passwordHash: "hash-member",
    role: "user",
  });
  assert.equal(member?.role, "user");
  await assert.rejects(
    firstPortal.createManagedLocalUser({
      actorUserId: demotedAdmin.id,
      email: "manager-created-by-admin@example.test",
      passwordHash: "hash-manager",
      role: "admin",
    }),
    (error: unknown) => error instanceof UserRoleUpdateError && error.code === "super_admin_required",
  );

  const externalTarget = await firstPortal.findOrCreateUser(
    "external-promoted@example.test",
    "external-promoted-subject",
    "sample-provider",
  );
  await firstPortal.saveSession(
    "external-session-before-promotion",
    externalTarget.id,
    new Date(Date.now() + 60_000),
    "sample-provider",
  );
  assert.equal((await firstPortal.changeUserRole({
    actorUserId: remainingSuperAdmin.id,
    targetUserId: externalTarget.id,
    expectedRole: "user",
    role: "admin",
    passwordHash: "hash-external-promoted",
  }))?.role, "admin");
  assert.equal(await firstPortal.sessionUser("external-session-before-promotion"), null);
  assert.equal(await firstPortal.getLocalPasswordHash(externalTarget.id), "hash-external-promoted");

  const waitingActor = await firstPortal.createManagedLocalUser({
    actorUserId: remainingSuperAdmin.id,
    email: "waiting-super@example.test",
    passwordHash: "hash-waiting-super",
    role: "super_admin",
  });
  assert.ok(waitingActor);
  const target = await firstPortal.createLocalUser("waiting-target@example.test", "hash-target");
  assert.ok(target);

  const lockClient = await control.connect();
  await lockClient.query("begin");
  await lockClient.query(`select pg_advisory_xact_lock(hashtext('openapp:role-governance'))`);
  const waitingChange = secondPortal.changeUserRole({
    actorUserId: waitingActor.id,
    targetUserId: target.id,
    expectedRole: "user",
    role: "admin",
  });
  await lockClient.query(`update users set role='admin' where id=$1`, [waitingActor.id]);
  await lockClient.query("commit");
  lockClient.release();
  await assert.rejects(
    waitingChange,
    (error: unknown) => error instanceof UserRoleUpdateError && error.code === "super_admin_required",
  );
  assert.equal((await firstPortal.getUser(target.id))?.role, "user");

  assert.equal((await firstPortal.changeUserRole({
    actorUserId: remainingSuperAdmin.id,
    targetUserId: demotedAdmin.id,
    expectedRole: "admin",
    role: "admin",
  }))?.role, "admin");
  const audit = await firstPortal.listAuditEvents({ action: "user.role.change" });
  assert.equal(audit.length, 2);
  assert.ok(audit.every((event) => (
    event.metadata
    && (event.metadata as { afterRole?: string }).afterRole === "admin"
  )));
});

async function seedManagementUser(
  pool: pg.Pool,
  email: string,
  passwordHash: string,
  role: "admin" | "super_admin",
): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<User>(
      `insert into users(id,email,role) values($1,$2,$3)
       returning id,email,role,created_at as "createdAt",app_initialized_at as "appInitializedAt"`,
      [randomUUID(), email, role],
    );
    const user = result.rows[0]!;
    await client.query(
      `insert into auth_identities(provider,subject,user_id,email_snapshot)
       values('local',$1,$2,$1)`,
      [email, user.id],
    );
    await client.query(
      `insert into local_credentials(user_id,password_hash) values($1,$2)`,
      [user.id, passwordHash],
    );
    await client.query("commit");
    return user;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
