import assert from "node:assert/strict";
import { lutimes, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupStaleUploadArtifacts } from "./upload-artifact-cleanup.js";

test("startup cleanup removes only expired Portal upload artifacts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-artifact-cleanup-"));
  const temporaryRoot = join(root, "tmp");
  const releaseRoot = join(root, "release");
  await Promise.all([mkdir(temporaryRoot), mkdir(releaseRoot)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const oldImage = join(temporaryRoot, "sample-app-image-old");
  const freshImage = join(temporaryRoot, "sample-app-image-fresh");
  const unrelated = join(temporaryRoot, "unrelated-cache");
  const oldUpload = join(releaseRoot, ".openapp-upload-old");
  const oldActivation = join(releaseRoot, ".sample-app-0.5.4.tgz.1700000000000-acde1234.tmp");
  const linkedTarget = join(root, "must-survive");
  const oldLink = join(releaseRoot, ".openapp-upload-link");
  await Promise.all([
    mkdir(oldImage),
    mkdir(freshImage),
    mkdir(unrelated),
    mkdir(oldUpload),
    writeFile(oldActivation, "temporary"),
    writeFile(linkedTarget, "keep"),
  ]);
  await symlink(linkedTarget, oldLink);
  const old = new Date("2026-01-01T00:00:00.000Z");
  const fresh = new Date("2026-01-01T23:30:00.000Z");
  await Promise.all([oldImage, unrelated, oldUpload, oldActivation].map((path) => utimes(path, old, old)));
  await Promise.all([lutimes(oldLink, old, old), utimes(freshImage, fresh, fresh)]);

  const result = await cleanupStaleUploadArtifacts({
    releaseRoot,
    temporaryRoot,
    staleAfterMs: 60 * 60_000,
    now: new Date("2026-01-02T00:00:00.000Z"),
    cleanupProfile: {
      imageTemporaryPrefixes: ["sample-app-image-"],
      releaseArtifactMatchers: [/^\.sample-app-(?:web-)?[^/]+\.\d+-[a-f0-9]{8}\.tmp$/u],
    },
  });

  assert.deepEqual(result, { checked: 5, removed: 4, errors: 0 });
  assert.deepEqual(await readdir(temporaryRoot), ["sample-app-image-fresh", "unrelated-cache"]);
  assert.deepEqual(await readdir(releaseRoot), []);
  assert.equal(await readText(linkedTarget), "keep");
});

test("startup cleanup removes generic image staging while retaining fresh and unrelated directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-generic-artifact-cleanup-"));
  const temporaryRoot = join(root, "tmp");
  const releaseRoot = join(root, "release");
  await Promise.all([mkdir(temporaryRoot), mkdir(releaseRoot)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const oldImage = join(temporaryRoot, "openapp-image-old");
  const freshImage = join(temporaryRoot, "openapp-image-fresh");
  const unrelated = join(temporaryRoot, "image-cache-that-is-not-portal");
  await Promise.all([mkdir(oldImage), mkdir(freshImage), mkdir(unrelated)]);
  const old = new Date("2026-01-01T00:00:00.000Z");
  const fresh = new Date("2026-01-01T23:30:00.000Z");
  await utimes(oldImage, old, old);
  await utimes(freshImage, fresh, fresh);

  const result = await cleanupStaleUploadArtifacts({
    releaseRoot,
    temporaryRoot,
    staleAfterMs: 60 * 60_000,
    now: new Date("2026-01-02T00:00:00.000Z"),
  });

  assert.equal(result.checked, 2);
  assert.equal(result.removed, 1);
  assert.deepEqual(await readdir(temporaryRoot), ["image-cache-that-is-not-portal", "openapp-image-fresh"]);
});

test("startup cleanup removes expired catalog upload staging directories", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-upload-catalog-"));
  const oldPath = join(root, "apps", "story-app", ".openapp-upload-old");
  const freshPath = join(root, "apps", "story-app", ".openapp-upload-fresh");
  await mkdir(oldPath, { recursive: true });
  await mkdir(freshPath, { recursive: true });
  const old = new Date("2026-07-15T00:00:00.000Z");
  await utimes(oldPath, old, old);
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await cleanupStaleUploadArtifacts({
    releaseRoot: root,
    temporaryRoot: root,
    now: new Date("2026-07-17T00:00:00.000Z"),
  });
  assert.equal(result.removed, 1);
  await assert.rejects(stat(oldPath));
  await stat(freshPath);
});

test("startup cleanup preserves referenced build packages and removes stale orphaned storage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-build-package-cleanup-"));
  const referenced = join(root, "build-packages", "package-kept");
  const orphaned = join(root, "build-packages", "package-orphaned");
  const staging = join(root, "build-packages", ".openapp-build-package-staging.tmp");
  const interruptedUpload = join(root, ".openapp-build-upload-interrupted");
  await Promise.all([
    mkdir(referenced, { recursive: true }),
    mkdir(orphaned, { recursive: true }),
    mkdir(staging, { recursive: true }),
    mkdir(interruptedUpload, { recursive: true }),
  ]);
  const old = new Date("2026-07-15T00:00:00.000Z");
  await Promise.all([referenced, orphaned, staging, interruptedUpload].map((path) => utimes(path, old, old)));
  t.after(() => rm(root, { recursive: true, force: true }));

  const result = await cleanupStaleUploadArtifacts({
    releaseRoot: root,
    temporaryRoot: join(root, "tmp"),
    now: new Date("2026-07-17T00:00:00.000Z"),
    buildPackages: [{
      id: "package-kept",
      storageKey: "build-packages/package-kept/backend.tgz",
    }],
  });

  assert.equal(result.removed, 3);
  await stat(referenced);
  await assert.rejects(stat(orphaned));
  await assert.rejects(stat(staging));
  await assert.rejects(stat(interruptedUpload));
});

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
