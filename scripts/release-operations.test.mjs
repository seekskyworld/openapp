import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
const run = promisify(execFile);

test("control build has exactly two Docker builds and rejects incomplete inputs before Docker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "control-release-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const release = join(root, "release");
  const bin = join(root, "bin");
  await mkdir(release);
  await mkdir(bin);
  for (const [source, target] of [["build-openapp.sh", "build-images.sh"], ["verify.mjs", "verify.mjs"]]) {
    await cp(join(process.cwd(), "scripts/release", source), join(release, target));
  }
  await writeFile(join(release, "payload"), "build inputs");
  const files = {};
  for (const name of ["build-images.sh", "verify.mjs", "payload"]) {
    files[name] = createHash("sha256").update(await readFile(join(release, name))).digest("hex");
  }
  await writeFile(join(release, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1, kind: "openapp-control-plane", sourceFingerprint: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files,
  }));
  const log = join(root, "docker.log");
  await writeFile(join(bin, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_DOCKER_LOG"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_DOCKER_LOG: log };
  await run("bash", [join(release, "build-images.sh")], { env });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((line) => line.startsWith("build ")));
  assert.match(calls[0], /-f core\/backend\/Dockerfile/);
  assert.match(calls[1], /-f core\/frontend\/Dockerfile/);
  assert.ok(calls.every((line) => !/compose|\bup\b/.test(line)));
  await rm(join(release, "payload"));
  await assert.rejects(run("bash", [join(release, "build-images.sh")], { env }), /missing, modified or unexpected/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
  await writeFile(join(release, "payload"), "build inputs");
  await writeFile(join(release, ".env"), "unexpected credentials");
  await assert.rejects(run(process.execPath, [join(release, "verify.mjs")]), /missing, modified or unexpected/);
});

test("relocated operations preserve explicit Compose identity and reject missing data root", async () => {
  const helper = join(process.cwd(), "scripts/release/compose-files.sh");
  const command = 'source "$TEST_HELPER"; declare -f openapp_compose; printf "%s\\n" "${openapp_compose_files[@]}"';
  const env = { ...process.env, TEST_HELPER: helper, ROOT_DIR: "/release/openapp/core",
    COMPOSE_PROJECT_NAME: "existing-project", OPENAPP_DATA_ROOT: tmpdir(), OPENAPP_COMPATIBILITY_MODE: "true" };
  const result = await run("bash", ["-eu", "-c", command], { env });
  assert.match(result.stdout, /--project-name/);
  assert.match(result.stdout, /--project-directory/);
  assert.match(result.stdout, /\/release\/openapp\/core\/docker-compose.legacy.yml/);
  await assert.rejects(run("bash", ["-eu", "-c", command], {
    env: { ...env, COMPOSE_PROJECT_NAME: "" },
  }), /existing Compose project name/);
  await assert.rejects(run("bash", ["-eu", "-c", command], {
    env: { ...env, OPENAPP_DATA_ROOT: "relative/data" },
  }), /existing absolute directory/);
});
