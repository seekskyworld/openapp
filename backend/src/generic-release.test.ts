import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { receiveBuildPackageUpload } from "./build-package-upload.js";
import { validateBuildPackageRequirements, validateUploadRequirements } from "@openapp/contracts";
import { AppCatalog } from "./app-catalog.js";
import { MemoryPersistence } from "./persistence/memory.js";
import { createGenericPortalStores } from "./stores-core.js";
import { AppImageUpdateCoordinator } from "./app-image-updates.js";
import { ImageBuildManager } from "./image-builds.js";
import { ImageBuildExecutor } from "./image-build-executor.js";
import { BuildStrategyRegistry } from "./build-strategies.js";
import { BuildPackageStorage } from "./build-package-upload.js";
import { createPortalContextAsync } from "./portal-context-core.js";
import { createPortalApp } from "./portal-app.js";
import { loadGenericConfig } from "./config-core.js";

test("image-only revisions are validated, activated and survive catalog recreation without package files", async (t) => {
  const releaseRoot = await mkdtemp(join(tmpdir(), "openapp-image-import-"));
  t.after(() => rm(releaseRoot, { recursive: true, force: true }));
  const persistence = new MemoryPersistence();
  const store = createGenericPortalStores(persistence).catalog;
  let validations = 0;
  let smokeTests = 0;
  const options = { store, releaseRoot, runtimeContractForApp: () => "sample-v1", resolveImage: async () => `sha256:${"a".repeat(64)}`, validateImage: async () => { validations++; }, validateCandidateImage: async () => { smokeTests++; } };
  const catalog = new AppCatalog(options);
  await catalog.createApp({ id: "sample", name: "Sample" });
  const revision = await catalog.importImage("sample", "sample:latest");
  assert.equal(revision.sourceKind, "image");
  assert.deepEqual(revision.packages, []);
  assert.equal(revision.status, "image_ready");
  assert.equal(validations, 1);
  assert.equal(smokeTests, 1);
  await catalog.activateVersion("sample", revision.id, 0);
  const restarted = new AppCatalog(options);
  await restarted.initialize();
  assert.equal((await restarted.launchTarget("sample")).version.id, revision.id);
  await assert.rejects(new AppCatalog({ ...options, validateImage: async () => { throw Error("unhealthy"); } }).importImage("sample", "bad:latest"), /runtime_image_contract_invalid/);
  assert.equal((await store.listAppVersions("sample")).length, 1);
  await assert.rejects(new AppCatalog({ ...options, validateCandidateImage: async () => { throw Error("smoke_failed"); } }).importImage("sample", "bad:latest"), /smoke_failed/);
  assert.equal((await store.listAppVersions("sample")).length, 1);
});

test("explicit strategy cannot bypass the App strategy allowlist", async () => {
  const coordinator = new AppImageUpdateCoordinator({ supportsStrategyForApp: () => false } as never);
  await assert.rejects(coordinator.createCandidate({ appId: "sample", strategyId: "other" } as never), /build_strategy_app_mismatch/);
});

test("shared package contract accepts arbitrary slots and rejects divergent definitions", () => {
  const requirement = { key: "model", required: true, acceptedExtensions: [".zip"] };
  assert.equal(validateBuildPackageRequirements([requirement])[0]?.key, "model");
  for (const input of [[], Array(33).fill(requirement), [{ ...requirement, acceptedExtensions: [] }], [{ ...requirement, acceptedExtensions: ["zip"] }], [{ ...requirement, maxBytes: 513 * 1024 * 1024 }]]) {
    assert.throws(() => validateBuildPackageRequirements(input));
  }
});

test("legacy upload declarations retain camelCase but reject paths, duplicates and excessive slots", () => {
  const slot = { key: "payloadFile", required: true, acceptedExtensions: [".zip"] };
  assert.equal(validateUploadRequirements([slot])[0]!.key, "payloadFile");
  for (const key of ["../escape", "/absolute", "a/b", "constructor", "__proto__"]) assert.throws(() => validateUploadRequirements([{ ...slot, key }]));
  assert.throws(() => validateUploadRequirements([slot, slot]));
  assert.throws(() => validateUploadRequirements(Array(33).fill(slot)));
});

test("multipart receiver preserves field identity while generating its own safe filename", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "openapp-safe-upload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const body = '--boundary\r\nContent-Disposition: form-data; name="payloadFile"; filename="payload.zip"\r\nContent-Type: application/zip\r\n\r\ncontent\r\n--boundary--\r\n';
  const request = Readable.from([Buffer.from(body)]) as IncomingMessage;
  request.headers = { "content-type": "multipart/form-data; boundary=boundary" };
  const strategy = { status: "active", packageRequirements: [{ key: "payloadFile", required: true, acceptedExtensions: [".zip"], maxBytes: 100 }] };
  const upload = await receiveBuildPackageUpload(request, root, strategy as never);
  assert.equal(upload.packages[0]!.key, "payloadFile");
  assert.match(basename(upload.packages[0]!.path), /^[a-f0-9-]{36}\.zip$/);
  assert.equal(dirname(dirname(upload.packages[0]!.path)), root);
  assert.equal(await readFile(upload.packages[0]!.path, "utf8"), "content");
  await upload.cleanup();
  await assert.rejects(receiveBuildPackageUpload(request, root, { ...strategy, packageRequirements: [{ ...strategy.packageRequirements[0], key: "../escape" }] } as never), /invalid_build_package_key/);
  assert.deepEqual(await readdir(root), []);
});

test("removing optional slots reaches the builder with the exact remaining selection", async () => {
  const strategy = { id: "sample", revision: 1, packageRequirements: [{ key: "model", required: false }] };
  let selected: readonly string[] | undefined;
  const coordinator = new AppImageUpdateCoordinator({
    supportsStrategyForApp: () => true,
    imageBuilds: { requireExecutableStrategy: async () => strategy },
    catalog: { listVersions: async () => [{ status: "active", revision: 1, packages: [{ key: "model", packageId: "old" }] }] },
    buildPackageStorage: { resolveSelection: async (_strategy: unknown, ids: string[]) => { selected = ids; throw new Error("selection_verified"); } },
  } as never);
  const input = { appId: "sample", strategyId: "sample", expectedRevision: 1, replacementPackageIds: { model: null }, requestedBy: "admin", operationId: "op", report: async () => {} };
  await assert.rejects(coordinator.createCandidate(input as never), /selection_verified/);
  assert.deepEqual(selected, []);
  strategy.packageRequirements[0]!.required = true;
  await assert.rejects(coordinator.createCandidate(input as never), /required_build_package_cannot_remove:model/);
});

test("package references accept renamed version files but reject altered content", async () => {
  const stores = createGenericPortalStores(new MemoryPersistence());
  const registry = new BuildStrategyRegistry([{ id: "sample", revision: 1, execute: async () => { throw Error("not invoked"); } }]);
  const manager = new ImageBuildManager({ store: stores.builds, strategyRegistry: registry });
  await manager.registerStrategy({ id: "sample", name: "Sample", runtimeContract: "sample-v1", packageRequirements: [{ key: "model", required: true, acceptedExtensions: [".zip"] }] });
  const artifact = { file: "random-upload.zip", sha256: "a".repeat(64), size: 10 };
  await stores.builds.createPackage({ id: "package", strategyId: "sample", key: "model", artifact, originalName: "model.zip", storageKey: "test/random-upload.zip", uploadedBy: "admin", createdAt: new Date().toISOString() });
  const input = { strategyId: "sample", requestedBy: "admin", packages: [{ key: "model", packageId: "package", artifact: { ...artifact, file: "model.zip" } }] };
  assert.equal((await manager.createBuild(input)).status, "queued");
  await assert.rejects(manager.createBuild({ ...input, packages: [{ ...input.packages[0]!, artifact: { ...artifact, sha256: "b".repeat(64) } }] }), /build_package_reference_mismatch/);
});

test("an all-optional strategy can build and activate an empty package revision with a verified artifact", async (t) => {
  const releaseRoot = await mkdtemp(join(tmpdir(), "openapp-optional-release-"));
  t.after(() => rm(releaseRoot, { recursive: true, force: true }));
  const stores = createGenericPortalStores(new MemoryPersistence());
  const image = `sha256:${"a".repeat(64)}`;
  const catalog = new AppCatalog({ store: stores.catalog, releaseRoot, runtimeContractForApp: () => "sample-v1", resolveImage: async () => image, validateImage: async () => {} });
  await catalog.createApp({ id: "sample", name: "Sample" });
  const registry = new BuildStrategyRegistry([{ id: "sample", revision: 1, inspectPackages: async () => ({ version: "1.0.0", buildId: "empty", packages: [] }), execute: async (input) => { assert.deepEqual(input.build.packages, []); return { imageReference: image, imageId: image }; } }]);
  const imageBuilds = new ImageBuildManager({ store: stores.builds, strategyRegistry: registry });
  await imageBuilds.registerStrategy({ id: "sample", name: "Sample", runtimeContract: "sample-v1", packageRequirements: [{ key: "model", required: false, acceptedExtensions: [".zip"] }] });
  await stores.builds.createPackage({ id: "old-package", strategyId: "sample", key: "model", artifact: { file: "model.zip", sha256: "b".repeat(64), size: 1 }, originalName: "model.zip", storageKey: "test/model.zip", uploadedBy: "admin", createdAt: new Date().toISOString() });
  await stores.catalog.saveAppVersion({ id: "old", appId: "sample", version: "1.0.0", buildId: "old", revision: 1, packages: [{ key: "model", packageId: "old-package", artifact: { file: "model.zip", sha256: "b".repeat(64), size: 1 } }], status: "active", imageReference: image, runtimeContract: "sample-v1", createdAt: new Date().toISOString(), activatedAt: null });
  const coordinator = new AppImageUpdateCoordinator({ catalog, imageBuilds, imageBuildExecutor: new ImageBuildExecutor({ manager: imageBuilds, releaseRoot, resolveVersion: id => stores.catalog.getAppVersion(id) }), buildPackageStorage: new BuildPackageStorage({ releaseRoot, store: stores.builds }), supportsStrategyForApp: () => true });
  await stores.admin.saveOperation({ id: "test-op", revision: 0, type: "app.image.update", status: "running", progress: 0, stage: "building", actorUserId: "admin", resourceType: "app", resourceId: "sample", requestId: "test", idempotencyKey: null, requestFingerprint: null, retryOf: null, cancellable: false, retryable: false, result: null, error: null, createdAt: new Date().toISOString(), startedAt: null, heartbeatAt: null, finishedAt: null });
  const result = await coordinator.createCandidate({ appId: "sample", strategyId: "sample", expectedRevision: 1, replacementPackageIds: { model: null }, requestedBy: "admin", operationId: "test-op", signal: new AbortController().signal, report: async () => {}, commitPoint: async () => {} });
  assert.deepEqual(result.revision.packages, []);
  assert.deepEqual(result.removedSlots, ["model"]);
  assert.ok(result.revision.imageArtifactId);
  const active = await coordinator.bindCandidate("sample", result.revision.id, 1);
  assert.equal(active.status, "active");
});

test("missing Adapter is rejected before multipart parsing or operation persistence", async (t) => {
  const releaseDir = await mkdtemp(join(tmpdir(), "openapp-upload-preflight-"));
  t.after(() => rm(releaseDir, { recursive: true, force: true }));
  const environment = { OPENAPP_CONTROL_PLANE_ONLY: "true", AUTH_PROVIDER: "none", DOCKER_HOST: "tcp://127.0.0.1:9" };
  const context = await createPortalContextAsync({ environment, config: { ...loadGenericConfig(environment), port: 0, releaseDir, adminCliToken: "audit-token" } });
  const portal = createPortalApp(context);
  await portal.start();
  t.after(() => new Promise<void>((resolve, reject) => portal.server.close(error => error ? reject(error) : resolve())));
  // 只切换请求门禁，保留无调度器的隔离宿主以验证普通模式缺插件路径。
  Object.assign(context.config, { controlPlaneOnly: false });
  await context.stores.builds.saveStrategy({ id: "missing", revision: 1, name: "Missing", description: "", runtimeContract: "sample-v1", packageRequirements: [{ key: "model", required: true, acceptedExtensions: [".zip"] }], status: "active", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const address = portal.server.address();
  assert.ok(address && typeof address !== "string");
  for (const path of ["/api/admin/build-packages?strategyId=missing&key=model", "/api/admin/image-builds?strategyId=missing"]) {
    const response: Response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "x-openapp-admin-token": "audit-token", "content-type": "invalid/multipart" }, body: "not a multipart body" });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, "build_strategy_adapter_not_found");
  }
  assert.deepEqual(await readdir(releaseDir), []);
  assert.deepEqual(await context.imageBuilds.listBuilds(), []);
});

test("image import is durable, queryable and idempotent across HTTP retries", async (t) => {
  const releaseDir = await mkdtemp(join(tmpdir(), "openapp-import-operation-"));
  t.after(() => rm(releaseDir, { recursive: true, force: true }));
  const environment = { OPENAPP_CONTROL_PLANE_ONLY: "true", AUTH_PROVIDER: "none", DOCKER_HOST: "tcp://127.0.0.1:9" };
  const context = await createPortalContextAsync({ environment, config: { ...loadGenericConfig(environment), port: 0, releaseDir, adminCliToken: "audit-token" } });
  const portal = createPortalApp(context);
  await portal.start();
  t.after(() => new Promise<void>((resolve, reject) => portal.server.close(error => error ? reject(error) : resolve())));
  Object.assign(context.config, { controlPlaneOnly: false });
  const getPlugin = context.plugins.get.bind(context.plugins);
  context.plugins.get = (id) => id === "sample" ? { manifest: { executionContracts: ["sample-v1"] } } as never : getPlugin(id);
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(() => release());
  context.catalog.importImage = async (_app, _reference, beforeSave) => {
    calls++;
    await gate;
    await beforeSave?.();
    return { id: "candidate", appId: "sample", imageReference: `sha256:${"a".repeat(64)}` } as never;
  };
  const address = portal.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { "x-openapp-admin-token": "audit-token", "content-type": "application/json", "idempotency-key": "import-retry-key" };
  const submit = (imageReference = "sample:latest") => fetch(`${base}/api/admin/apps/sample/image-imports`, { method: "POST", headers, body: JSON.stringify({ imageReference }) });
  const first = await submit();
  assert.equal(first.status, 202);
  const result = await first.json() as { operationId: string };
  const second = await submit();
  assert.equal(second.status, 202);
  assert.equal((await second.json() as { operationId: string }).operationId, result.operationId);
  assert.equal((await submit("different:latest")).status, 409);
  release();
  let status = "";
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${base}/api/admin/operations/${result.operationId}`, { headers });
    const value = await response.json() as { operation: { status: string } };
    status = value.operation.status;
    if (status === "succeeded" || status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(status, "succeeded");
  assert.equal(calls, 1);
});
