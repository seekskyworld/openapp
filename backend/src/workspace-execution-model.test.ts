import assert from "node:assert/strict";
import test from "node:test";
import type { Container } from "./models.js";
import {
  projectContainerToWorkspaceExecution,
  projectWorkspaceExecutionToContainer,
} from "./workspace-execution-model.js";

test("legacy Container projects to one active Docker execution without losing its snapshot", () => {
  const container = fixtureContainer({
    status: "stopped",
    endpoint: null,
    stopReason: "manual_user",
  });

  const projection = projectContainerToWorkspaceExecution(container);

  assert.deepEqual(projection.workspace, {
    id: "workspace-1",
    ownerId: "owner-1",
    appId: "sample-app",
    appRevisionId: "app-version-7",
    storageRefId: "workspace-storage:workspace-1",
    activeExecutionId: "workspace-1:docker",
    status: "active",
    deletionTransactionId: null,
    deletionPhase: null,
    deletionFailure: null,
    deletedAt: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T01:00:00.000Z",
  });
  assert.deepEqual(projection.execution, {
    id: "workspace-1:docker",
    workspaceId: "workspace-1",
    role: "active",
    providerId: "docker",
    environmentRef: "runtime-1",
    desiredGeneration: 1,
    deployedGeneration: 1,
    healthyGeneration: null,
    transactionId: "legacy-import:workspace-1",
    transactionStatus: "applied",
    desiredState: "stopped",
    observedState: "stopped",
    desiredAppRevisionId: "app-version-7",
    desiredLaunchArtifactId: "image-artifact-7",
    desiredLaunchArtifactReference: "sha256:image-7",
    launchArtifactId: "image-artifact-7",
    launchArtifactReference: "sha256:image-7",
    revision: 1,
    legacyEndpoint: null,
    stopReason: "manual_user",
    lastActivityAt: "2026-08-04T00:30:00.000Z",
    retiredAt: null,
    updatedAt: "2026-08-04T01:00:00.000Z",
  });
  assert.deepEqual(projectWorkspaceExecutionToContainer(projection), container);
});

test("running and failed compatibility projections retain their desired and observed dimensions", () => {
  const running = projectContainerToWorkspaceExecution(fixtureContainer());
  assert.deepEqual({
    desired: running.execution.desiredState,
    observed: running.execution.observedState,
    deployed: running.execution.deployedGeneration,
    healthy: running.execution.healthyGeneration,
    transaction: running.execution.transactionStatus,
  }, {
    desired: "running",
    observed: "running",
    deployed: 1,
    healthy: 1,
    transaction: "applied",
  });

  const failed = projectContainerToWorkspaceExecution(fixtureContainer({
    status: "failed",
    endpoint: null,
    stopReason: "failure",
  }));
  assert.deepEqual({
    desired: failed.execution.desiredState,
    observed: failed.execution.observedState,
    transaction: failed.execution.transactionStatus,
  }, {
    desired: "running",
    observed: "failed",
    transaction: "failed",
  });
});

test("compatibility projection rejects a mismatched active execution", () => {
  const projection = projectContainerToWorkspaceExecution(fixtureContainer());

  assert.throws(
    () => projectWorkspaceExecutionToContainer({
      ...projection,
      workspace: { ...projection.workspace, activeExecutionId: "other-execution" },
    }),
    /workspace_execution_projection_mismatch/u,
  );
});

function fixtureContainer(overrides: Partial<Container> = {}): Container {
  return {
    id: "workspace-1",
    userId: "owner-1",
    appId: "sample-app",
    runtimeId: "runtime-1",
    status: "running",
    endpoint: "http://workspace-1.test",
    stopReason: null,
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T01:00:00.000Z",
    lastActivityAt: "2026-08-04T00:30:00.000Z",
    appVersionId: "app-version-7",
    imageArtifactId: "image-artifact-7",
    imageReference: "sha256:image-7",
    ...overrides,
  };
}
