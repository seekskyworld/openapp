import assert from "node:assert/strict";
import test from "node:test";
import { PortalMaintenanceCoordinator } from "./portal-maintenance.js";

test("maintenance cycle lets the rollout worker finish before idle sweep takes instance leases", async () => {
  const firstWorker = deferred<void>();
  const secondWorker = deferred<void>();
  const events: string[] = [];
  let workerRuns = 0;
  let concurrentTasks = 0;
  let maxConcurrentTasks = 0;
  const coordinator = new PortalMaintenanceCoordinator({
    async runUpgradeRolloutWorker() {
      concurrentTasks += 1;
      maxConcurrentTasks = Math.max(maxConcurrentTasks, concurrentTasks);
      workerRuns += 1;
      events.push(`worker:${workerRuns}:start`);
      await (workerRuns === 1 ? firstWorker.promise : secondWorker.promise);
      events.push(`worker:${workerRuns}:finish`);
      concurrentTasks -= 1;
    },
    async sweepIdleContainers() {
      concurrentTasks += 1;
      maxConcurrentTasks = Math.max(maxConcurrentTasks, concurrentTasks);
      events.push("sweep");
      concurrentTasks -= 1;
    },
    onError() {
      assert.fail("maintenance task must not fail");
    },
  });

  const cycle = coordinator.requestMaintenanceCycle();
  await immediate();
  assert.deepEqual(events, ["worker:1:start"]);

  // API 在 worker 执行期间创建的新批次必须排在 sweep 前再跑一轮，
  // 不能把新请求合并丢失后继续让 sweep 抢占实例租约。
  assert.equal(coordinator.requestUpgradeRun(), cycle);
  firstWorker.resolve();
  await immediate();
  assert.deepEqual(events, ["worker:1:start", "worker:1:finish", "worker:2:start"]);

  secondWorker.resolve();
  await cycle;
  assert.deepEqual(events, [
    "worker:1:start",
    "worker:1:finish",
    "worker:2:start",
    "worker:2:finish",
    "sweep",
  ]);
  assert.equal(maxConcurrentTasks, 1);
});

test("maintenance task failures are isolated and later requests remain runnable", async () => {
  const events: string[] = [];
  const errors: string[] = [];
  let workerRuns = 0;
  const coordinator = new PortalMaintenanceCoordinator({
    async runUpgradeRolloutWorker() {
      workerRuns += 1;
      events.push(`worker:${workerRuns}`);
      if (workerRuns === 1) throw new Error("worker_failed");
    },
    async sweepIdleContainers() {
      events.push("sweep");
    },
    onError(task, error) {
      errors.push(`${task}:${error instanceof Error ? error.message : String(error)}`);
    },
  });

  await coordinator.requestMaintenanceCycle();
  await coordinator.requestUpgradeRun();

  assert.deepEqual(events, ["worker:1", "sweep", "worker:2"]);
  assert.deepEqual(errors, ["upgrade-rollout-worker:worker_failed"]);
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function immediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

test("shutdown waits for active maintenance and suppresses queued/new work", async () => {
  const pending = deferred<void>();
  let workers = 0;
  let sweeps = 0;
  const coordinator = new PortalMaintenanceCoordinator({
    async runUpgradeRolloutWorker() {
      workers++;
      await pending.promise;
    },
    async sweepIdleContainers() {
      sweeps++;
    },
    onError() {
      assert.fail("unexpected maintenance failure");
    },
  });
  void coordinator.requestMaintenanceCycle();
  let stopped = false;
  const stop = coordinator.stop().then(() => {
    stopped = true;
  });
  await immediate();
  assert.equal(stopped, false);
  pending.resolve();
  await stop;
  await coordinator.requestMaintenanceCycle();
  assert.equal(workers, 1);
  assert.equal(sweeps, 0);
});
