/**
 * Rollout cohort 与错误预算决策保持纯函数，供 durable worker 或管理台在同一输入上重放。
 * 它不直接修改批次状态，也不决定 Provider 行为，因此可在现有 rollout 事务旁增量启用。
 */

export interface RolloutCohortPolicy {
  canarySize?: number;
  batchSize: number;
  maxFailureRate: number;
  maxFailures: number;
  pauseOnErrorBudget?: boolean;
}

export interface RolloutCohort {
  index: number;
  canary: boolean;
  instanceIds: readonly string[];
}

export type RolloutGateDecision =
  | { status: "wait"; reason: "cohort_incomplete" }
  | { status: "promote"; reason: "cohort_healthy"; failureRate: number }
  | { status: "pause"; reason: "error_budget_exceeded" | "needs_attention"; failureRate: number }
  | { status: "abort"; reason: "max_failures_exceeded"; failureRate: number };

export interface RolloutGateInput {
  cohortSize: number;
  completed: number;
  succeeded: number;
  failed: number;
  needsAttention?: number;
}

export class RolloutCohortError extends Error {
  constructor(readonly code: "rollout_cohort_invalid_policy" | "rollout_cohort_invalid_ids") {
    super(code);
    this.name = "RolloutCohortError";
  }
}

export function partitionRolloutCohorts(
  instanceIds: readonly string[],
  policy: RolloutCohortPolicy,
): readonly RolloutCohort[] {
  const ids = normalizeIds(instanceIds);
  const normalized = normalizePolicy(policy);
  if (ids.length === 0) return [];
  const canarySize = Math.min(normalized.canarySize, ids.length);
  const cohorts: RolloutCohort[] = [];
  let offset = 0;
  let index = 0;
  if (canarySize > 0) {
    cohorts.push({ index, canary: true, instanceIds: ids.slice(0, canarySize) });
    offset = canarySize;
    index += 1;
  }
  while (offset < ids.length) {
    cohorts.push({
      index,
      canary: false,
      instanceIds: ids.slice(offset, offset + normalized.batchSize),
    });
    offset += normalized.batchSize;
    index += 1;
  }
  return cohorts;
}

export function evaluateRolloutGate(
  input: RolloutGateInput,
  policy: RolloutCohortPolicy,
): RolloutGateDecision {
  const normalized = normalizePolicy(policy);
  if (!Number.isSafeInteger(input.cohortSize) || input.cohortSize <= 0) {
    throw new RolloutCohortError("rollout_cohort_invalid_policy");
  }
  if (![input.completed, input.succeeded, input.failed, input.needsAttention ?? 0].every((value) => (
    Number.isSafeInteger(value) && value >= 0
  ))) {
    throw new RolloutCohortError("rollout_cohort_invalid_policy");
  }
  const needsAttention = input.needsAttention ?? 0;
  if (
    input.completed > input.cohortSize
    || input.succeeded + input.failed > input.completed
    || needsAttention > input.completed
  ) {
    throw new RolloutCohortError("rollout_cohort_invalid_policy");
  }
  if (input.completed < input.cohortSize) return { status: "wait", reason: "cohort_incomplete" };
  const failureRate = input.failed / input.cohortSize;
  if (needsAttention > 0) {
    return { status: "pause", reason: "needs_attention", failureRate };
  }
  if (input.failed > normalized.maxFailures) {
    return { status: "abort", reason: "max_failures_exceeded", failureRate };
  }
  if (normalized.pauseOnErrorBudget && failureRate > normalized.maxFailureRate) {
    return { status: "pause", reason: "error_budget_exceeded", failureRate };
  }
  return { status: "promote", reason: "cohort_healthy", failureRate };
}

function normalizePolicy(policy: RolloutCohortPolicy): Required<RolloutCohortPolicy> {
  const canarySize = policy.canarySize ?? 0;
  const pauseOnErrorBudget = policy.pauseOnErrorBudget ?? true;
  if (!Number.isSafeInteger(canarySize) || canarySize < 0) throw new RolloutCohortError("rollout_cohort_invalid_policy");
  if (!Number.isSafeInteger(policy.batchSize) || policy.batchSize <= 0) throw new RolloutCohortError("rollout_cohort_invalid_policy");
  if (!Number.isFinite(policy.maxFailureRate) || policy.maxFailureRate < 0 || policy.maxFailureRate > 1) {
    throw new RolloutCohortError("rollout_cohort_invalid_policy");
  }
  if (!Number.isSafeInteger(policy.maxFailures) || policy.maxFailures < 0) throw new RolloutCohortError("rollout_cohort_invalid_policy");
  return { canarySize, batchSize: policy.batchSize, maxFailureRate: policy.maxFailureRate, maxFailures: policy.maxFailures, pauseOnErrorBudget };
}

function normalizeIds(instanceIds: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const value of instanceIds) {
    if (typeof value !== "string") throw new RolloutCohortError("rollout_cohort_invalid_ids");
    const id = value.trim();
    if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id) || seen.has(id)) {
      throw new RolloutCohortError("rollout_cohort_invalid_ids");
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}
