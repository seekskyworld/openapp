import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateRolloutGate,
  partitionRolloutCohorts,
  RolloutCohortError,
} from "./rollout-cohort.js";

const policy = {
  canarySize: 2,
  batchSize: 3,
  maxFailureRate: 0.25,
  maxFailures: 2,
};

test("cohort partitioning keeps deterministic order and canary boundary", () => {
  const cohorts = partitionRolloutCohorts(["a", "b", "c", "d", "e", "f", "g"], policy);
  assert.deepEqual(cohorts, [
    { index: 0, canary: true, instanceIds: ["a", "b"] },
    { index: 1, canary: false, instanceIds: ["c", "d", "e"] },
    { index: 2, canary: false, instanceIds: ["f", "g"] },
  ]);
});

test("cohort gate waits, promotes healthy cohorts, and pauses on error budget", () => {
  assert.deepEqual(evaluateRolloutGate({ cohortSize: 2, completed: 1, succeeded: 1, failed: 0 }, policy), {
    status: "wait",
    reason: "cohort_incomplete",
  });
  assert.deepEqual(evaluateRolloutGate({ cohortSize: 2, completed: 2, succeeded: 2, failed: 0 }, policy), {
    status: "promote",
    reason: "cohort_healthy",
    failureRate: 0,
  });
  assert.deepEqual(evaluateRolloutGate({ cohortSize: 3, completed: 3, succeeded: 2, failed: 1 }, policy), {
    status: "pause",
    reason: "error_budget_exceeded",
    failureRate: 1 / 3,
  });
});

test("needs-attention and hard failure limits have explicit decisions", () => {
  assert.equal(evaluateRolloutGate({ cohortSize: 3, completed: 3, succeeded: 2, failed: 1, needsAttention: 1 }, policy).status, "pause");
  assert.equal(evaluateRolloutGate({ cohortSize: 3, completed: 3, succeeded: 0, failed: 3 }, policy).status, "abort");
});

test("invalid policies and duplicate IDs fail closed", () => {
  assert.throws(
    () => partitionRolloutCohorts(["same", "same"], policy),
    (error: unknown) => error instanceof RolloutCohortError && error.code === "rollout_cohort_invalid_ids",
  );
  assert.throws(
    () => evaluateRolloutGate({ cohortSize: 1, completed: 1, succeeded: 1, failed: 0 }, { ...policy, maxFailureRate: 2 }),
    (error: unknown) => error instanceof RolloutCohortError && error.code === "rollout_cohort_invalid_policy",
  );
  assert.throws(
    () => evaluateRolloutGate({ cohortSize: 2, completed: 3, succeeded: 3, failed: 0 }, policy),
    (error: unknown) => error instanceof RolloutCohortError && error.code === "rollout_cohort_invalid_policy",
  );
  assert.throws(
    () => evaluateRolloutGate({ cohortSize: 2, completed: 2, succeeded: 2, failed: 1 }, policy),
    (error: unknown) => error instanceof RolloutCohortError && error.code === "rollout_cohort_invalid_policy",
  );
});
