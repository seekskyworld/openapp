import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactOperationError,
  DockerArtifactAdapter,
} from "./artifact-provider.js";
import { ContainerArtifactValidationError, type ContainerRuntime } from "./runtime.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

test("Docker artifact adapter exposes image operations without execution lifecycle access", async () => {
  const calls: string[] = [];
  const adapter = new DockerArtifactAdapter(runtime({
    async listImages() {
      calls.push("list");
      return [{ reference: "sample-app:test", id: DIGEST, size: "42MB" }];
    },
    async resolveImage(reference) {
      calls.push(`resolve:${reference}`);
      return DIGEST;
    },
    async validateImage(reference, contract) { calls.push(`validate:${reference}:${contract}`); },
    async validateBuiltImage(reference, contract) { calls.push(`validate-built:${reference}:${contract}`); },
    async removeImageIfCurrent(reference, imageId) {
      calls.push(`remove:${reference}:${imageId}`);
      return true;
    },
    async pullImage(reference) { calls.push(`pull:${reference}`); },
    async loadImage(path, reference) { calls.push(`load:${path}:${reference}`); },
  }));

  assert.deepEqual(await adapter.listImages(), [{ reference: "sample-app:test", id: DIGEST, size: "42MB" }]);
  assert.equal(await adapter.resolveImage("sample-app:test"), DIGEST);
  await adapter.validateImage(DIGEST, "sample-app-v1");
  await adapter.validateBuiltImage(DIGEST, "sample-app-v1");
  assert.equal(await adapter.removeImageIfCurrent("sample-app:test", DIGEST), true);
  await adapter.pullImage("sample-app:test");
  await adapter.loadImage("/tmp/image.tar", "sample-app:test");
  assert.deepEqual(calls, [
    "list",
    "resolve:sample-app:test",
    `validate:${DIGEST}:sample-app-v1`,
    `validate-built:${DIGEST}:sample-app-v1`,
    `remove:sample-app:test:${DIGEST}`,
    "pull:sample-app:test",
    "load:/tmp/image.tar:sample-app:test",
  ]);
});

test("Docker artifact adapter resolves through inventory when direct resolution is unsupported", async () => {
  const adapter = new DockerArtifactAdapter(runtime({
    resolveImage: undefined,
    async listImages() {
      return [{ reference: "sample-app:fallback", id: DIGEST }];
    },
  }));

  assert.equal(await adapter.resolveImage("sample-app:fallback"), DIGEST);
  assert.equal(await adapter.resolveImage("sample-app:missing"), null);
});

test("Docker artifact adapter distinguishes unsupported, unavailable, and invalid operations", async () => {
  const unsupported = new DockerArtifactAdapter(runtime({ pullImage: undefined }));
  await assert.rejects(
    unsupported.pullImage("sample-app:test"),
    (error: unknown) => error instanceof ArtifactOperationError
      && error.code === "runtime_image_pull_unavailable"
      && error.artifactFailureKind === "unsupported"
      && error.failureClass === "permanent"
      && error.retryable === false
      && error.status === 501,
  );

  const unavailable = new DockerArtifactAdapter(runtime({
    async listImages() { throw new Error("private daemon address"); },
  }));
  await assert.rejects(
    unavailable.listImages(),
    (error: unknown) => error instanceof ArtifactOperationError
      && error.code === "runtime_image_listing_failed"
      && error.artifactFailureKind === "unavailable"
      && error.failureClass === "transient"
      && error.retryable === true
      && error.status === 503
      && !error.code.includes("private daemon address"),
  );

  const invalid = new DockerArtifactAdapter(runtime({
    async validateImage() {
      throw new ContainerArtifactValidationError("runtime_image_contract_invalid", "invalid");
    },
  }));
  await assert.rejects(
    invalid.validateImage(DIGEST, "sample-app-v1"),
    (error: unknown) => error instanceof ArtifactOperationError
      && error.code === "runtime_image_contract_invalid"
      && error.artifactFailureKind === "invalid"
      && error.failureClass === "permanent"
      && error.retryable === false
      && error.status === 409,
  );

  const validationUnavailable = new DockerArtifactAdapter(runtime({
    async validateImage() { throw new Error("private daemon address"); },
  }));
  await assert.rejects(
    validationUnavailable.validateImage(DIGEST, "sample-app-v1"),
    (error: unknown) => error instanceof ArtifactOperationError
      && error.code === "runtime_image_validation_unavailable"
      && error.artifactFailureKind === "unavailable"
      && error.failureClass === "transient"
      && error.retryable === true
      && error.status === 503
      && !error.code.includes("private daemon address"),
  );
});

function runtime(overrides: Partial<ContainerRuntime> = {}): ContainerRuntime {
  return {
    async provision() { throw new Error("not used"); },
    async get() { return null; },
    async start() { throw new Error("not used"); },
    async stop() { throw new Error("not used"); },
    async sampleActivity() { throw new Error("not used"); },
    async remove() {},
    async listImages() { return []; },
    async resolveImage() { return null; },
    async validateImage() {},
    async validateBuiltImage() {},
    async removeImageIfCurrent() { return false; },
    async pullImage() {},
    async loadImage() {},
    ...overrides,
  };
}
