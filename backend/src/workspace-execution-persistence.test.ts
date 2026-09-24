import assert from "node:assert/strict";
import test from "node:test";

import type { Container } from "./models.js";
import { MemoryPersistence } from "./persistence/memory.js";
import type { InstanceActivityLease } from "./instance-upgrade-activity.js";
import {
  WorkspaceExecutionCasRequiredError,
  WorkspaceExecutionGenerationRollbackError,
} from "./workspace-execution-model.js";

test("container writes maintain a lossless WorkspaceExecution compatibility projection", async () => {
  const persistence = new MemoryPersistence();
  const container = fixtureContainer();

  await persistence.saveContainer(container);

  assert.deepEqual(await persistence.getContainer(container.id), container);
  const projection = await persistence.getWorkspaceExecutionProjection(container.id);
  assert.equal(projection?.workspace.id, container.id);
  assert.equal(projection?.workspace.storageRefId, `workspace-storage:${container.id}`);
  assert.equal(projection?.execution.id, `${container.id}:docker`);
  assert.equal(projection?.execution.environmentRef, container.runtimeId);
  assert.equal(projection?.execution.observedState, container.status);
  assert.equal(projection?.execution.revision, 1);
});

test("WorkspaceExecution CAS has one winner and advances its revision", async () => {
  const persistence = new MemoryPersistence();
  const container = fixtureContainer();
  await persistence.saveContainer(container);
  const current = await persistence.getWorkspaceExecutionProjection(container.id);
  assert.ok(current);

  const results = await Promise.all([
    persistence.compareAndSaveWorkspaceExecution({
      ...structuredClone(current),
      execution: {
        ...structuredClone(current.execution),
        desiredGeneration: 2,
        deployedGeneration: 2,
        transactionId: "generation-two-a",
        transactionStatus: "applied",
      },
    }, current.execution.revision),
    persistence.compareAndSaveWorkspaceExecution({
      ...structuredClone(current),
      execution: {
        ...structuredClone(current.execution),
        desiredGeneration: 2,
        deployedGeneration: 2,
        transactionId: "generation-two-b",
        transactionStatus: "applied",
      },
    }, current.execution.revision),
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean)?.execution.revision, 2);
  assert.equal((await persistence.getWorkspaceExecutionProjection(container.id))?.execution.desiredGeneration, 2);
});

test("WorkspaceExecution CAS rejects generation rollback and unfenced legacy writes", async () => {
  const persistence = new MemoryPersistence();
  const container = fixtureContainer();
  await persistence.saveContainer(container);
  const current = await persistence.getWorkspaceExecutionProjection(container.id);
  assert.ok(current);
  const advanced = await persistence.compareAndSaveWorkspaceExecution({
    ...structuredClone(current),
    execution: {
      ...structuredClone(current.execution),
      desiredGeneration: 3,
      deployedGeneration: 2,
      healthyGeneration: 2,
      transactionId: "generation-three",
      transactionStatus: "progressing",
    },
  }, current.execution.revision);
  assert.ok(advanced);

  await assert.rejects(
    persistence.compareAndSaveWorkspaceExecution({
      ...structuredClone(advanced),
      execution: {
        ...structuredClone(advanced.execution),
        desiredGeneration: 2,
      },
    }, advanced.execution.revision),
    WorkspaceExecutionGenerationRollbackError,
  );
  await assert.rejects(
    persistence.updateContainer({ ...container, status: "stopped", updatedAt: "2026-08-04T00:01:00.000Z" }),
    WorkspaceExecutionCasRequiredError,
  );
});

test("deleting Workspaces reject new and renewed activity leases", async () => {
  const persistence = new MemoryPersistence();
  const container = fixtureContainer();
  await persistence.saveContainer(container);
  const lease: InstanceActivityLease = {
    id: "workspace-deletion-existing-lease",
    instanceId: container.id,
    kind: "http",
    openedAt: container.createdAt,
    heartbeatAt: container.createdAt,
    lastActivityAt: container.createdAt,
  };
  assert.equal(await persistence.tryOpenInstanceActivityLease(lease, lease.openedAt), true);

  const current = await persistence.getWorkspaceExecutionProjection(container.id);
  assert.ok(current);
  const deleting = structuredClone(current);
  deleting.workspace.status = "deleting";
  deleting.workspace.deletionTransactionId = "workspace-deletion-transaction";
  deleting.workspace.deletionPhase = "draining";
  assert.ok(await persistence.compareAndSaveWorkspaceExecution(deleting, current.execution.revision));

  assert.equal(
    await persistence.tryOpenInstanceActivityLease(
      { ...lease, id: "workspace-deletion-new-lease" },
      "2026-08-04T00:01:00.000Z",
    ),
    false,
  );
  assert.equal(
    await persistence.renewInstanceActivityLease(
      { ...lease, heartbeatAt: "2026-08-04T00:01:00.000Z" },
      "2026-08-04T00:01:00.000Z",
    ),
    false,
  );
});

function fixtureContainer(): Container {
  return {
    id: "workspace-persistence-test",
    userId: "workspace-persistence-owner",
    appId: "sample-app",
    runtimeId: "runtime-persistence-test",
    status: "running",
    endpoint: "http://workspace-persistence.test",
    stopReason: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    lastActivityAt: "2026-08-04T00:00:00.000Z",
    appVersionId: "release-persistence-test",
    imageArtifactId: "artifact-persistence-test",
    imageReference: "sha256:persistence-test",
  };
}
