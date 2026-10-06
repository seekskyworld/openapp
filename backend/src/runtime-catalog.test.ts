import assert from "node:assert/strict";
import test from "node:test";
import type { AppVersion, ImageArtifact } from "./models.js";
import { isRuntimeCatalogSnapshotValid } from "./runtime-catalog.js";

test("catalog observations must bind the same App, version, artifact and image", async () => {
  const artifact: ImageArtifact = {
    id: "artifact", buildId: "build", imageReference: "sample:release", imageId: "sha256:image",
    runtimeContract: "none", createdAt: "2026-10-06T00:00:00Z",
  };
  const version: AppVersion = {
    id: "version", appId: "sample", version: "1.0.0", buildId: "build",
    imageArtifactId: artifact.id, imageReference: artifact.imageId, status: "archived",
    createdAt: artifact.createdAt, activatedAt: null,
  };
  const catalog = { getAppVersion: async (id: string) => id === version.id ? version : null };
  const builds = { getArtifact: async (id: string) => id === artifact.id ? artifact : null };
  const snapshot = { appId: version.appId, appVersionId: version.id, imageArtifactId: artifact.id, imageReference: artifact.imageId };
  assert.equal(await isRuntimeCatalogSnapshotValid(snapshot, catalog, builds), true);
  assert.equal(await isRuntimeCatalogSnapshotValid({ ...snapshot, imageReference: artifact.imageReference }, catalog, builds), true);
  for (const change of [
    { appId: "another-app" }, { appVersionId: "missing" }, { imageArtifactId: "missing" },
    { imageArtifactId: null }, { imageReference: "sha256:wrong" },
  ]) {
    assert.equal(await isRuntimeCatalogSnapshotValid({ ...snapshot, ...change }, catalog, builds), false);
  }
  version.imageReference = "sha256:another-image";
  assert.equal(await isRuntimeCatalogSnapshotValid(snapshot, catalog, builds), false);
});
