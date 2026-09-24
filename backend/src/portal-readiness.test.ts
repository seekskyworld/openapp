/** 模拟依赖失败/恢复与超时，确保就绪检查不会并发堆积。 */
import test from "node:test";
import assert from "node:assert/strict";
import { createReadinessProbe } from "./portal-readiness.js";
test("readiness reports failure and recovers", async () => {
  let failed = true;
  const probe = createReadinessProbe(async () => {
    if (failed) throw Error("private database address");
  });
  assert.equal(await probe(), false);
  failed = false;
  assert.equal(await probe(), true);
});
test("readiness timeout reuses the pending dependency probe", async () => {
  let count = 0;
  let release!: () => void;
  const probe = createReadinessProbe(() => {
    count++;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  }, 5);
  assert.equal(await probe(), false);
  assert.equal(await probe(), false);
  assert.equal(count, 1);
  release();
});
