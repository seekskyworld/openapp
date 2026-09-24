import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateAdapterRuntime } from "./validate-adapter-runtime.mjs";

async function fixture(options = {}) {
  const root = await mkdtemp(join(tmpdir(), "openapp-adapter-runtime-"));
  const runtime = join(root, "runtime");
  await mkdir(runtime, { recursive: true });
  const contextFiles = options.contextFiles ?? ["start.sh", "recover-state-locks.mjs"];
  const profile = {
    ...(options.includeAppId === false ? {} : { appId: options.appId ?? "demo" }),
    runtimeContract: options.runtimeContract ?? "demo-v1",
    contextFiles,
  };
  const dockerfile = options.dockerfile ?? [
    "FROM scratch",
    "ARG APP_PACKAGE",
    "COPY ${APP_PACKAGE} /tmp/app.tgz",
    "COPY start.sh recover-state-locks.mjs /opt/app/",
  ].join("\n");
  await writeFile(join(runtime, "Dockerfile"), dockerfile);
  await writeFile(join(runtime, "profile.json"), JSON.stringify(profile));
  for (const path of contextFiles) {
    const absolute = join(runtime, path);
    await mkdir(join(absolute, ".."), { recursive: true });
    await writeFile(absolute, `context: ${path}\n`);
  }
  return { root, runtime };
}

test("validates a closed Runtime context and returns ordered copy paths", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await validateAdapterRuntime({ adapterRoot: value.root, appId: "demo" });
  assert.deepEqual(result.contextFiles, ["start.sh", "recover-state-locks.mjs"]);
  assert.equal(result.contextPaths.length, 2);
  assert.equal(result.runtimeContract, "demo-v1");
  assert.deepEqual(result.dockerfileSources, ["start.sh", "recover-state-locks.mjs"]);
});

test("supports nested context files while preserving the boundary", async (t) => {
  const value = await fixture({
    contextFiles: ["start.sh", "scripts/recover.mjs"],
    dockerfile: "FROM scratch\nCOPY start.sh scripts/recover.mjs /opt/app/\n",
  });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const result = await validateAdapterRuntime({ adapterRoot: value.root });
  assert.deepEqual(result.contextFiles, ["start.sh", "scripts/recover.mjs"]);
});

test("rejects files that are not registered in contextFiles", async (t) => {
  const value = await fixture();
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await writeFile(join(value.runtime, "forgotten.sh"), "legacy\n");
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: value.root }),
    /contains unregistered files: forgotten\.sh/u,
  );
});

test("rejects symlinks in the Runtime tree", async (t) => {
  const value = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "openapp-runtime-outside-"));
  t.after(async () => {
    await rm(value.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  await writeFile(join(outside, "recover.mjs"), "export {};\n");
  await rm(join(value.runtime, "recover-state-locks.mjs"));
  await symlink(join(outside, "recover.mjs"), join(value.runtime, "recover-state-locks.mjs"));
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: value.root }),
    /symlink is not allowed/u,
  );
});

test("rejects path traversal and duplicate context declarations", async (t) => {
  const traversal = await fixture({
    contextFiles: ["start.sh", "../outside.mjs"],
    dockerfile: "FROM scratch\nCOPY start.sh /opt/app/\n",
  });
  t.after(() => rm(traversal.root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: traversal.root }),
    /path is unsafe/u,
  );

  const duplicate = await fixture({
    contextFiles: ["start.sh", "start.sh"],
    dockerfile: "FROM scratch\nCOPY start.sh /opt/app/\n",
  });
  t.after(() => rm(duplicate.root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: duplicate.root }),
    /contain duplicates/u,
  );
});

test("requires Dockerfile sources to be declared and rejects globs", async (t) => {
  const undeclared = await fixture({
    contextFiles: ["start.sh", "recover-state-locks.mjs"],
    dockerfile: "FROM scratch\nCOPY helper.sh /opt/app/\n",
  });
  t.after(() => rm(undeclared.root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: undeclared.root }),
    /Dockerfile source is not in the Runtime boundary: helper\.sh/u,
  );

  const glob = await fixture({
    dockerfile: "FROM scratch\nCOPY *.sh /opt/app/\n",
  });
  t.after(() => rm(glob.root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: glob.root }),
    /source glob is not allowed/u,
  );
});

test("checks the optional Runtime App identity", async (t) => {
  const value = await fixture({ appId: "other" });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: value.root, appId: "demo" }),
    /does not match requested App/u,
  );
});

test("requires an App identity only for an external Adapter Runtime", async (t) => {
  const value = await fixture({ includeAppId: false });
  t.after(() => rm(value.root, { recursive: true, force: true }));
  const genericResult = await validateAdapterRuntime({ adapterRoot: value.root });
  assert.equal(genericResult.appId, undefined);
  await assert.rejects(
    validateAdapterRuntime({ adapterRoot: value.root, appId: "demo", requireAppId: true }),
    /appId is required/u,
  );
});
