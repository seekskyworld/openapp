import test from "node:test";
import assert from "node:assert/strict";
import { withRuntimeCleanup } from "./runtime-cleanup.js";
test("cleanup preserves both the operation and cleanup error", async () => {
  const primary = Error("probe failed");
  const cleanup = Error("cleanup failed");
  await assert.rejects(
    withRuntimeCleanup(
      async () => {
        throw primary;
      },
      async () => {
        throw cleanup;
      },
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.equal(error.cause, primary);
      return true;
    },
  );
  await assert.rejects(
    withRuntimeCleanup(
      async () => {
        throw primary;
      },
      async () => {},
    ),
    (error) => error === primary,
  );
  await assert.rejects(
    withRuntimeCleanup(
      async () => 1,
      async () => {
        throw cleanup;
      },
    ),
    (error) => error === cleanup,
  );
  assert.equal(
    await withRuntimeCleanup(
      async () => 1,
      async () => {},
    ),
    1,
  );
});
