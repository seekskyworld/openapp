import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneGenericArtifacts } from "./prune-generic-artifacts.mjs";

test("generic artifact pruning removes compatibility output but keeps neutral runtime files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-artifact-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(root, "backend/dist/auth/compat"), { recursive: true }),
    mkdir(join(root, "backend/dist/legacy/sample-app"), { recursive: true }),
    mkdir(join(root, "backend/runtime/dist"), { recursive: true }),
    mkdir(join(root, "frontend/web/assets"), { recursive: true }),
    mkdir(join(root, "release/backend"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "backend/dist/server-generic.js"), "export const marker = 'generic';\n"),
    writeFile(join(root, "backend/dist/server.js"), "Sample App legacy entry\n"),
    writeFile(join(root, "backend/dist/auth/compat/provider-auth.js"), "legacy\n"),
    writeFile(join(root, "backend/dist/legacy/sample-app/plugin.js"), "legacy\n"),
    writeFile(
      join(root, "backend/dist/neutral.js"),
      "// Sample App is mentioned only in this comment\nexport {};\n",
    ),
    writeFile(join(root, "backend/dist/neutral.test.js"), "test\n"),
    writeFile(join(root, "backend/dist/neutral.d.ts"), "declare const value: string;\n"),
    writeFile(join(root, "backend/dist/neutral.js.map"), "{}\n"),
    writeFile(join(root, "backend/runtime/dist/index.js"), "export const runtime = true;\n"),
    writeFile(join(root, "backend/runtime/dist/runtime-compat.js"), "SAMPLE_APP legacy\n"),
    writeFile(join(root, "frontend/web/index.html"), "<title>OpenApp</title>\n"),
    writeFile(
      join(root, "frontend/web/assets/index.js"),
      "console.log('generic');\n//# sourceMappingURL=index.js.map\n",
    ),
    writeFile(join(root, "frontend/web/assets/provider-selection-abc.js"), "legacy\n"),
    writeFile(join(root, "frontend/web/assets/provider-selection-abc.js.map"), "{}\n"),
    writeFile(
      join(root, "release/backend/app.tgz"),
      "Sample App business package is an allowed external input\n",
    ),
  ]);

  const removed = await pruneGenericArtifacts(root);
  assert.ok(removed.includes("backend/dist/server.js"));
  assert.ok(removed.includes("frontend/web/assets/provider-selection-abc.js"));
  await access(join(root, "backend/dist/server-generic.js"));
  await access(join(root, "backend/dist/neutral.js"));
  await access(join(root, "backend/runtime/dist/index.js"));
  await access(join(root, "frontend/web/assets/index.js"));
  await access(join(root, "release/backend/app.tgz"));
  await assert.rejects(access(join(root, "backend/dist/server.js")));
  await assert.rejects(access(join(root, "backend/runtime/dist/runtime-compat.js")));
  assert.doesNotMatch(
    await readFile(join(root, "frontend/web/assets/index.js"), "utf8"),
    /sourceMappingURL/u,
  );

  // 第二次执行不应因为已清理路径不存在而失败。
  await pruneGenericArtifacts(root);
});

test("generic artifact pruning rejects symlinked compatibility paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-artifact-prune-link-"));
  const outside = await mkdtemp(join(tmpdir(), "openapp-artifact-prune-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await mkdir(join(root, "backend/dist"), { recursive: true });
  await mkdir(join(root, "backend/runtime/dist"), { recursive: true });
  await mkdir(join(root, "frontend/web"), { recursive: true });
  await writeFile(join(outside, "legacy.js"), "legacy\n");
  await symlink(join(outside, "legacy.js"), join(root, "backend/dist/server.js"));
  await assert.rejects(pruneGenericArtifacts(root), /rejects symlink/u);
});

test("CLI invoked through a directory alias executes pruning and remains idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-artifact-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const build = join(root, "build");
  await mkdir(join(build, "backend/runtime/dist"), { recursive: true });
  await writeFile(join(build, "backend/runtime/dist/index.d.ts"), "export declare const value: string;\n");
  await writeFile(join(build, "backend/runtime/dist/index.js"), "export const value = 'kept';\n");
  await symlink(import.meta.dirname, join(root, "scripts-alias"), "dir");
  const invoke = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [join(root, "scripts-alias/prune-generic-artifacts.mjs"), "--root", build],
        { encoding: "utf8" },
      ),
    );
  assert.deepEqual(invoke(), { ok: true, removed: ["backend/runtime/dist/index.d.ts"] });
  await access(join(build, "backend/runtime/dist/index.js"));
  await assert.rejects(access(join(build, "backend/runtime/dist/index.d.ts")), { code: "ENOENT" });
  assert.deepEqual(invoke(), { ok: true, removed: [] });
});
