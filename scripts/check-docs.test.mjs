import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findBrokenLinks } from "./check-docs.mjs";

test("documentation checker accepts local assets and rejects missing targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-docs-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "docs/assets"), { recursive: true });
  await writeFile(
    join(root, "docs/index.md"),
    "[guide](guide.md#guide) ![logo](assets/logo.svg) [external](https://example.test)\n",
  );
  await writeFile(join(root, "docs/guide.md"), "# Guide\n");
  await writeFile(join(root, "docs/assets/logo.svg"), "<svg />\n");
  assert.deepEqual(await findBrokenLinks(root, ["docs/index.md"]), []);
  await writeFile(join(root, "docs/index.md"), "[missing](missing.md)\n");
  assert.deepEqual(await findBrokenLinks(root, ["docs/index.md"]), ["docs/index.md: missing.md"]);
  await writeFile(join(root, "docs/index.md"), "[missing heading](guide.md#missing)\n");
  assert.deepEqual(await findBrokenLinks(root, ["docs/index.md"]), [
    "docs/index.md: missing heading anchor: guide.md#missing",
  ]);
});
