import assert from "node:assert/strict";
import test from "node:test";

import { ProviderOperationError } from "./execution-provider.js";
import {
  needsReconciliation,
  WorkspaceExecutionReconciler,
} from "./workspace-execution-reconciler.js";
import type { WorkspaceExecutionProjection } from "./workspace-execution.js";
import type { WorkspaceExecutionReconcileInput } from "./workspace-execution-manager.js";

test("reconciler processes only active drift and reports terminal skips", async () => {
  const active = projection("active", "active", "stopped");
  const converged = projection("converged", "active", "running");
  const deleting = projection("deleting", "deleting", "stopped");
  const calls: string[] = [];
  const reconciler = new WorkspaceExecutionReconciler({
    listProjections: async () => [converged, deleting, active],
    resolveInput: async (item) => input(item.workspace.id),
    execution: {
      reconcile: async (item) => {
        calls.push(item.workspaceId);
        return active;
      },
    },
  });

  const report = await reconciler.runOnce();
  assert.deepEqual(calls, ["active"]);
  assert.equal(report.scanned, 3);
  assert.equal(report.selected, 1);
  assert.equal(report.reconciled, 1);
  assert.equal(report.skipped, 2);
  assert.equal(report.failed, 0);
  assert.equal(report.entries.find((entry) => entry.workspaceId === "deleting")?.reason, "workspace_deleting");
});

test("transient Provider failures retry with a bound and permanent failures stop", async () => {
  const active = projection("retry", "active", "stopped");
  let attempts = 0;
  const reconciler = new WorkspaceExecutionReconciler({
    listProjections: async () => [active],
    resolveInput: async () => input("retry"),
    execution: {
      reconcile: async () => {
        attempts += 1;
        if (attempts < 3) throw new ProviderOperationError("provider_temporarily_unavailable", "transient", "reconcile");
        return active;
      },
    },
    maxAttempts: 3,
    retryDelayMs: 1,
  });
  const report = await reconciler.runOnce();
  assert.equal(report.reconciled, 1);
  assert.equal(report.entries[0]?.attempts, 3);

  const permanent = new WorkspaceExecutionReconciler({
    listProjections: async () => [active],
    resolveInput: async () => input("retry"),
    execution: {
      reconcile: async () => { throw new ProviderOperationError("provider_contract_rejected", "permanent", "reconcile"); },
    },
    maxAttempts: 3,
    retryDelayMs: 1,
  });
  const failed = await permanent.runOnce();
  assert.equal(failed.failed, 1);
  assert.equal(failed.entries[0]?.attempts, 1);
  assert.equal(failed.entries[0]?.reason, "provider_contract_rejected");
});

test("a busy global or workspace lease is reported without adopting unknown resources", async () => {
  const active = projection("busy", "active", "stopped");
  const reconciler = new WorkspaceExecutionReconciler({
    listProjections: async () => [active],
    resolveInput: async () => input("busy"),
    execution: { reconcile: async () => active },
    withLease: async () => null,
  });
  const report = await reconciler.runOnce();
  assert.equal(report.scanned, 0);
  assert.equal(report.busy, 0);
  assert.equal(report.entries.length, 0);
});

test("needsReconciliation excludes failed transactions and recognizes generation drift", () => {
  const failed = projection("failed", "active", "failed");
  failed.execution.transactionStatus = "failed";
  assert.equal(needsReconciliation(failed), false);
  const drift = projection("drift", "active", "stopped");
  drift.execution.desiredGeneration = 2;
  assert.equal(needsReconciliation(drift), true);
});

function input(workspaceId: string): WorkspaceExecutionReconcileInput {
  return {
    workspaceId,
    ownerId: "owner",
    appId: "app",
    appRevisionId: "revision",
    launchArtifactId: "artifact",
    launchArtifactReference: "sha256:artifact",
    launchProfile: {
      imageReference: "sha256:artifact",
      resources: { memory: "1g", cpus: "1", pidsLimit: 32 },
      environment: {},
      configFiles: [],
    },
    desiredState: "running",
    replace: false,
  };
}

function projection(
  id: string,
  status: "active" | "deleting",
  observedState: "running" | "stopped" | "failed",
): WorkspaceExecutionProjection {
  return {
    workspace: {
      id,
      ownerId: "owner",
      appId: "app",
      appRevisionId: "revision",
      storageRefId: `storage:${id}`,
      activeExecutionId: `${id}:docker`,
      status,
      deletionTransactionId: null,
      deletionPhase: null,
      deletionFailure: null,
      deletedAt: null,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
    execution: {
      id: `${id}:docker`,
      workspaceId: id,
      role: "active",
      providerId: "docker",
      environmentRef: observedState === "stopped" ? "runtime" : "runtime",
      desiredGeneration: 1,
      deployedGeneration: 1,
      healthyGeneration: observedState === "running" ? 1 : null,
      transactionId: null,
      transactionStatus: "applied",
      desiredState: "running",
      observedState,
      desiredAppRevisionId: "revision",
      desiredLaunchArtifactId: "artifact",
      desiredLaunchArtifactReference: "sha256:artifact",
      launchArtifactId: "artifact",
      launchArtifactReference: "sha256:artifact",
      revision: 1,
      legacyEndpoint: null,
      stopReason: null,
      lastActivityAt: "2026-08-28T00:00:00.000Z",
      retiredAt: null,
      updatedAt: "2026-08-28T00:00:00.000Z",
    },
    compatibility: { runtimeId: "runtime", status: observedState === "failed" ? "failed" : observedState },
  };
}
