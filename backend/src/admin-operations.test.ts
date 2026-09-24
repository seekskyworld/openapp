import assert from "node:assert/strict";
import test from "node:test";
import {
  AdminOperationConflictError,
  AdminOperationManager,
  AdminOperationTaskError,
  MemoryOperationStore,
  type AdminOperation,
} from "./admin-operations.js";

test("admin operations persist progress and completion", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  const created = await manager.start({
    type: "image.pull",
    actorUserId: "admin-1",
    resourceType: "image",
    resourceId: "openapp:test",
  }, async ({ report }) => {
    await report(40, "downloading");
    await report(90, "verifying");
    return { reference: "openapp:test" };
  });

  assert.equal(created.status, "queued");
  const completed = await waitForTerminal(manager, created.id);
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.progress, 100);
  assert.equal(completed.stage, "completed");
  assert.deepEqual(completed.result, { reference: "openapp:test" });
});

test("admin operations keep a bounded error and can be retried", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  const failed = await manager.start({
    type: "maintenance.sweep",
    actorUserId: "admin-1",
    resourceType: "maintenance",
    resourceId: "idle",
    retryable: true,
  }, async () => {
    throw new Error("runtime unavailable token=secret-value");
  });

  const terminal = await waitForTerminal(manager, failed.id);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.error, "runtime unavailable token=[REDACTED]");

  const retried = await manager.retry(failed.id, async () => ({ checked: 1 }));
  assert.equal(retried.retryOf, failed.id);
  assert.equal((await waitForTerminal(manager, retried.id)).status, "succeeded");
});

test("admin operation results redact credential-shaped fields before persistence", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  const operation = await manager.start({
    type: "maintenance.sweep",
    actorUserId: "admin-1",
    resourceType: "maintenance",
  }, async () => ({ accessToken: "secret", nested: { password: "secret", ok: true } }));
  const completed = await waitForTerminal(manager, operation.id);
  assert.deepEqual(completed.result, { accessToken: "[REDACTED]", nested: { password: "[REDACTED]", ok: true } });
});

test("failed task results remain visible for partial batch failures", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  const operation = await manager.start({
    type: "container.batch.stop",
    actorUserId: "admin-1",
    resourceType: "container",
    retryable: true,
  }, async () => {
    throw new AdminOperationTaskError("batch_operation_failed", {
      requested: 2,
      succeeded: 1,
      failed: 1,
      results: [{ id: "instance-1", ok: true }, { id: "instance-2", ok: false, error: "runtime unavailable" }],
    });
  });

  const completed = await waitForTerminal(manager, operation.id);
  assert.equal(completed.status, "failed");
  assert.equal(completed.retryable, true);
  assert.deepEqual(completed.result, {
    requested: 2,
    succeeded: 1,
    failed: 1,
    results: [{ id: "instance-1", ok: true }, { id: "instance-2", ok: false, error: "runtime unavailable" }],
  });
});

test("running side effects cannot be falsely cancelled", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = await manager.start({
    type: "app.version.upload",
    actorUserId: "admin-1",
    resourceType: "app-version",
  }, async () => blocked);
  await waitForStatus(manager, operation.id, "running");
  await assert.rejects(manager.cancel(operation.id), /operation_not_cancellable/u);
  release();
  assert.equal((await waitForTerminal(manager, operation.id)).status, "succeeded");
});

test("cooperative cancellation stays in cancelling until the task observes abort", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  let observedAbort = false;
  const operation = await manager.start({
    type: "container.batch.start",
    actorUserId: "admin-1",
    resourceType: "container",
    cancellable: true,
    retryable: true,
  }, async ({ signal }) => new Promise<void>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      observedAbort = true;
      reject(new Error("operation_cancelled"));
    }, { once: true });
  }));
  await waitForStatus(manager, operation.id, "running");

  const requested = await manager.cancel(operation.id);
  assert.equal(requested?.status, "running");
  assert.equal(requested?.stage, "cancelling");
  const terminal = await waitForTerminal(manager, operation.id);
  assert.equal(observedAbort, true);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.error, null);
});

test("cooperative cancellation preserves a task's partial result", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = await manager.start({
    type: "container.batch.stop",
    actorUserId: "admin-1",
    resourceType: "container",
    cancellable: true,
    retryable: true,
  }, async ({ signal }) => {
    await blocked;
    return { completed: ["instance-1"], cancelled: signal.aborted };
  });
  await waitForStatus(manager, operation.id, "running");
  await manager.cancel(operation.id);
  release();

  const terminal = await waitForTerminal(manager, operation.id);
  assert.equal(terminal.status, "cancelled");
  assert.deepEqual(terminal.result, { completed: ["instance-1"], cancelled: true });
});

test("a remote cancellation that wins before the commit point prevents the side effect", async () => {
  const store = new MemoryOperationStore();
  const executor = new AdminOperationManager(store);
  const coordinator = new AdminOperationManager(store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let sideEffectCommitted = false;
  const operation = await executor.start({
    type: "image.build",
    actorUserId: "admin-1",
    resourceType: "image-build",
    cancellable: true,
  }, async ({ commitPoint }) => {
    await blocked;
    await commitPoint();
    sideEffectCommitted = true;
  });
  await waitForStatus(executor, operation.id, "running");

  const cancelling = await coordinator.cancel(operation.id);
  assert.equal(cancelling?.stage, "cancelling");
  release();

  const terminal = await waitForTerminal(executor, operation.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(sideEffectCommitted, false);
});

test("a commit point that wins before remote cancellation makes the operation non-cancellable", async () => {
  const store = new MemoryOperationStore();
  const executor = new AdminOperationManager(store);
  const coordinator = new AdminOperationManager(store);
  let committed!: () => void;
  const committedPromise = new Promise<void>((resolve) => { committed = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = await executor.start({
    type: "image.build",
    actorUserId: "admin-1",
    resourceType: "image-build",
    cancellable: true,
  }, async ({ commitPoint }) => {
    await commitPoint();
    committed();
    await blocked;
    return { artifactId: "artifact-1" };
  });
  await committedPromise;

  const finalizing = await executor.get(operation.id);
  assert.equal(finalizing?.status, "running");
  assert.equal(finalizing?.stage, "finalizing");
  assert.equal(finalizing?.cancellable, false);
  await assert.rejects(coordinator.cancel(operation.id), /operation_not_cancellable/u);
  release();

  const terminal = await waitForTerminal(executor, operation.id);
  assert.equal(terminal.status, "succeeded");
  assert.deepEqual(terminal.result, { artifactId: "artifact-1" });
});

test("recovered operations cannot be retried without an in-process task", async () => {
  const store = new MemoryOperationStore();
  const manager = new AdminOperationManager(store);
  await store.saveOperation({
    id: "restarted-operation",
    revision: 1,
    type: "image.pull",
    status: "running",
    progress: 42,
    stage: "pulling",
    actorUserId: "admin-1",
    resourceType: "image",
    resourceId: "openapp:test",
    requestId: "request-1",
    idempotencyKey: null,
    requestFingerprint: null,
    retryOf: null,
    cancellable: false,
    retryable: true,
    result: null,
    error: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    startedAt: "2020-01-01T00:00:01.000Z",
    heartbeatAt: "2020-01-01T00:00:01.000Z",
    finishedAt: null,
  });

  assert.equal(await manager.recoverInterrupted(), 1);
  const recovered = await manager.get("restarted-operation");
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.retryable, false);
  await assert.rejects(manager.retry("restarted-operation"), /operation_retry_unavailable/u);
});

test("fresh heartbeats are not recovered and null heartbeats fall back to started time", async () => {
  const now = new Date("2026-01-01T00:10:00.000Z");
  const store = new MemoryOperationStore();
  const manager = new AdminOperationManager(store, () => now);
  const base = {
    revision: 1,
    type: "image.pull",
    status: "running" as const,
    progress: 10,
    stage: "pulling",
    actorUserId: "admin-1",
    resourceType: "image",
    resourceId: "openapp:test",
    requestId: "request-1",
    idempotencyKey: null,
    requestFingerprint: null,
    retryOf: null,
    cancellable: false,
    retryable: true,
    result: null,
    error: null,
    createdAt: "2025-12-31T23:00:00.000Z",
    finishedAt: null,
  };
  await store.saveOperation({
    ...base,
    id: "fresh-heartbeat",
    startedAt: "2025-12-31T23:00:01.000Z",
    heartbeatAt: "2026-01-01T00:09:30.000Z",
  });
  await store.saveOperation({
    ...base,
    id: "legacy-heartbeat",
    startedAt: "2025-12-31T23:00:01.000Z",
    heartbeatAt: null,
  });

  assert.equal(await manager.recoverInterrupted(60_000), 1);
  assert.equal((await manager.get("fresh-heartbeat"))?.status, "running");
  assert.equal((await manager.get("legacy-heartbeat"))?.status, "failed");
});

test("a recovered task cannot be resurrected by its previous executor", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const store = new MemoryOperationStore();
  const executor = new AdminOperationManager(store, () => now);
  const recovery = new AdminOperationManager(store, () => now);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = await executor.start({
    type: "app.version.upload",
    actorUserId: "admin-1",
    resourceType: "app-version",
  }, async () => {
    await blocked;
    return { activated: true };
  });
  await waitForStatus(executor, operation.id, "running");

  now = new Date("2026-01-01T00:11:00.000Z");
  assert.equal(await recovery.recoverInterrupted(), 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));

  const recovered = await recovery.get(operation.id);
  assert.equal(recovered?.status, "failed");
  assert.equal(recovered?.stage, "interrupted");
  assert.equal(recovered?.result, null);
});

test("a cancellation from another manager is observed at the next task checkpoint", async () => {
  const store = new MemoryOperationStore();
  const executor = new AdminOperationManager(store);
  const coordinator = new AdminOperationManager(store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = await executor.start({
    type: "container.batch.stop",
    actorUserId: "admin-1",
    resourceType: "container",
    cancellable: true,
    retryable: true,
  }, async ({ report }) => {
    await blocked;
    await report(50, "stop:1/2");
  });
  await waitForStatus(executor, operation.id, "running");
  assert.equal((await coordinator.cancel(operation.id))?.stage, "cancelling");
  release();
  assert.equal((await waitForTerminal(executor, operation.id)).status, "cancelled");
});

test("a remote cancellation racing the terminal write still reaches cancelled", async () => {
  const store = new TerminalWriteRaceStore();
  const executor = new AdminOperationManager(store);
  const coordinator = new AdminOperationManager(store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = await executor.start({
    type: "container.batch.stop",
    actorUserId: "admin-1",
    resourceType: "container",
    cancellable: true,
  }, async () => {
    await blocked;
    return { completed: ["instance-1"] };
  });
  await waitForStatus(executor, operation.id, "running");
  store.beforeTerminalWrite = async () => {
    const cancelling = await coordinator.cancel(operation.id);
    assert.equal(cancelling?.stage, "cancelling");
  };
  release();

  const terminal = await waitForTerminal(executor, operation.id);
  assert.equal(terminal.status, "cancelled");
  assert.deepEqual(terminal.result, { completed: ["instance-1"] });
});

test("a remote cancellation racing a failed terminal write does not leave cancelling stuck", async () => {
  const store = new TerminalWriteRaceStore();
  const executor = new AdminOperationManager(store);
  const coordinator = new AdminOperationManager(store);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const operation = await executor.start({
    type: "container.batch.stop",
    actorUserId: "admin-1",
    resourceType: "container",
    cancellable: true,
  }, async () => {
    await blocked;
    throw new Error("runtime unavailable");
  });
  await waitForStatus(executor, operation.id, "running");
  store.beforeTerminalWrite = async () => {
    const cancelling = await coordinator.cancel(operation.id);
    assert.equal(cancelling?.stage, "cancelling");
  };
  release();

  const terminal = await waitForTerminal(executor, operation.id);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.error, null);
});

test("idempotency key returns the existing operation", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  const input = {
    type: "image.pull",
    actorUserId: "admin-1",
    resourceType: "image",
    resourceId: "openapp:test",
    idempotencyKey: "request-1",
  } as const;
  const first = await manager.start(input, async () => undefined);
  const second = await manager.start(input, async () => undefined);
  assert.equal(second.id, first.id);
});

test("idempotency keys cannot be reused for a different operation", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  await manager.start({
    type: "image.pull",
    actorUserId: "admin-1",
    resourceType: "image",
    resourceId: "openapp:test",
    idempotencyKey: "request-1",
  }, async () => undefined);
  await assert.rejects(
    manager.start({
      type: "app.version.upload",
      actorUserId: "admin-1",
      resourceType: "app-version",
      idempotencyKey: "request-1",
    }, async () => undefined),
    AdminOperationConflictError,
  );
});

test("idempotency keys cannot be reused for a different request fingerprint", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  const input = {
    type: "container.batch.start",
    actorUserId: "admin-1",
    resourceType: "container",
    idempotencyKey: "request-1",
  } as const;
  await manager.start({ ...input, requestFingerprint: "sha256:first" }, async () => undefined);
  await assert.rejects(
    manager.start({ ...input, requestFingerprint: "sha256:second" }, async () => undefined),
    AdminOperationConflictError,
  );
});

test("concurrent starts atomically create and execute one idempotent operation", async () => {
  const store = new MemoryOperationStore();
  const firstManager = new AdminOperationManager(store);
  const secondManager = new AdminOperationManager(store);
  let executions = 0;
  const input = {
    type: "container.batch.start",
    actorUserId: "admin-1",
    resourceType: "container",
    idempotencyKey: "concurrent-request",
    requestFingerprint: "sha256:shared",
  } as const;
  const task = async (): Promise<void> => { executions += 1; };

  const [first, second] = await Promise.all([
    firstManager.start(input, task),
    secondManager.start(input, task),
  ]);
  assert.equal(second.id, first.id);
  await waitForTerminal(firstManager, first.id);
  assert.equal(executions, 1);
  assert.equal((await store.listOperations()).length, 1);
});

test("concurrent retries reserve the failed operation exactly once", async () => {
  const manager = new AdminOperationManager(new MemoryOperationStore());
  const failed = await manager.start({
    type: "image.pull",
    actorUserId: "admin-1",
    resourceType: "image",
    resourceId: "openapp:test",
    retryable: true,
  }, async () => { throw new Error("transient"); });
  await waitForTerminal(manager, failed.id);

  const retries = await Promise.allSettled([manager.retry(failed.id), manager.retry(failed.id)]);
  assert.equal(retries.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(retries.filter((result) => result.status === "rejected").length, 1);
  const operations = await manager.list();
  assert.equal(operations.filter((operation) => operation.retryOf === failed.id).length, 1);
});

async function waitForTerminal(manager: AdminOperationManager, id: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operation = await manager.get(id);
    assert.ok(operation);
    if (["succeeded", "failed", "cancelled"].includes(operation.status)) return operation;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("operation did not complete");
}

async function waitForStatus(manager: AdminOperationManager, id: string, status: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const operation = await manager.get(id);
    if (operation?.status === status) return operation;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`operation did not reach ${status}`);
}

class TerminalWriteRaceStore extends MemoryOperationStore {
  beforeTerminalWrite?: () => Promise<void>;

  override async compareAndSaveOperation(operation: AdminOperation, expectedRevision: number) {
    if (["succeeded", "failed", "cancelled"].includes(operation.status) && this.beforeTerminalWrite) {
      const beforeTerminalWrite = this.beforeTerminalWrite;
      this.beforeTerminalWrite = undefined;
      await beforeTerminalWrite();
    }
    return super.compareAndSaveOperation(operation, expectedRevision);
  }
}
