import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { validateAdapterAssets } from "./validate-adapter-assets.mjs";

test("validates referenced adapter assets without executing adapter code", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-adapter-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "assets", "icons"), { recursive: true });
  await writeFile(join(root, "dist", "manifest.js"), "export const logo = '/adapter-assets/demo/icons/logo.svg';\n");
  await writeFile(join(root, "dist", "adapter.test.js"), "export const fixture = '/adapter-assets/demo/missing-from-production.svg';\n");
  await writeFile(join(root, "dist", "manifest.d.ts"), "export declare const logo: string;\n");
  await writeFile(join(root, "dist", "manifest.js.map"), "{}\n");
  await writeFile(join(root, "assets", "icons", "logo.svg"), "<svg></svg>\n");
  assert.deepEqual(await validateAdapterAssets(root, "demo"), {
    assets: ["icons/logo.svg"],
    references: ["icons/logo.svg"],
  });
});

test("rejects missing, symlinked, and unsafe adapter assets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-adapter-assets-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "dist", "manifest.js"), "export const logo = '/adapter-assets/demo/missing.svg';\n");
  await assert.rejects(validateAdapterAssets(root, "demo"), /missing\.svg/u);

  await writeFile(join(root, "assets", "real.svg"), "svg\n");
  await rm(join(root, "dist", "manifest.js"));
  await writeFile(join(root, "dist", "manifest.js"), "export const logo = '/adapter-assets/demo/real.svg';\n");
  await symlink(join(root, "assets", "real.svg"), join(root, "assets", "linked.svg"));
  await assert.rejects(validateAdapterAssets(root, "demo"), /symlink/u);
});

test("rejects an asset URL namespace that differs from the packaged adapter id", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-adapter-assets-namespace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "assets", "logo.svg"), "svg\n");
  await writeFile(join(root, "dist", "manifest.js"), "export const logo = '/adapter-assets/other/logo.svg';\n");
  await assert.rejects(validateAdapterAssets(root, "demo"), /namespace does not match/u);
});
