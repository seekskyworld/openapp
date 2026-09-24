import assert from "node:assert/strict";
import test from "node:test";

import {
  ArtifactProvenanceError,
  assertArtifactActivatable,
  validateArtifactProvenance,
  verifyArtifactProvenance,
} from "./artifact-provenance.js";

const digest = `sha256:${"a".repeat(64)}`;
const input = {
  digest,
  builderIdentity: "ci/openapp-builder",
  sourceRevision: "git:abc123",
  sbomReference: "oci://registry.example/sbom@sha256:bbb",
  provenanceReference: "oci://registry.example/provenance@sha256:ccc",
};

test("provenance validation normalizes digests and defaults legacy artifacts to unsigned", () => {
  const provenance = validateArtifactProvenance({ ...input, digest: digest.toUpperCase(), provenanceReference: undefined });
  assert.equal(provenance.digest, digest);
  assert.equal(provenance.signatureStatus, "unsigned");
  assert.equal(provenance.provenanceReference, undefined);
});

test("invalid or incomplete provenance fails closed", () => {
  assert.throws(
    () => validateArtifactProvenance({ ...input, digest: "latest" }),
    (error: unknown) => error instanceof ArtifactProvenanceError && error.field === "digest",
  );
  assert.throws(
    () => validateArtifactProvenance({ ...input, signatureStatus: "verified", provenanceReference: undefined }),
    (error: unknown) => error instanceof ArtifactProvenanceError && error.field === "provenanceReference",
  );
});

test("verification distinguishes unsigned, rejected and unavailable results", async () => {
  const unsigned = await verifyArtifactProvenance(input, undefined);
  assert.equal(unsigned.status, "unsigned");
  await assert.rejects(
    verifyArtifactProvenance(input, undefined, { requireVerified: true }),
    (error: unknown) => error instanceof ArtifactProvenanceError && error.code === "artifact_provenance_required",
  );

  const rejected = await verifyArtifactProvenance(input, {
    verify: async (provenance) => ({ status: "rejected", provenance, reason: "signature_mismatch" }),
  });
  assert.equal(rejected.status, "rejected");

  await assert.rejects(
    verifyArtifactProvenance(input, { verify: async () => { throw new Error("kms_timeout"); } }),
    (error: unknown) => error instanceof ArtifactProvenanceError
      && error.code === "artifact_provenance_unavailable"
      && error.status === 503,
  );
});

test("a declared verified status is never trusted without a verifier", async () => {
  await assert.rejects(
    verifyArtifactProvenance({ ...input, signatureStatus: "verified" }, undefined),
    (error: unknown) => error instanceof ArtifactProvenanceError
      && error.code === "artifact_provenance_unavailable"
      && error.status === 503,
  );
});

test("verifier cannot replace the immutable source identity", async () => {
  await assert.rejects(
    verifyArtifactProvenance(input, {
      verify: async (provenance) => ({
        status: "verified",
        provenance: { ...provenance, sourceRevision: "git:tampered" },
      }),
    }),
    (error: unknown) => error instanceof ArtifactProvenanceError
      && error.code === "artifact_provenance_rejected"
      && error.field === "provenance",
  );
});

test("aborted verification remains an abort instead of becoming a retryable outage", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller_cancelled"));
  await assert.rejects(
    verifyArtifactProvenance(input, { verify: async () => ({
      status: "verified",
      provenance: validateArtifactProvenance({ ...input, signatureStatus: "verified" }),
    }) }, { signal: controller.signal }),
    (error: unknown) => error instanceof Error && error.message === "caller_cancelled",
  );
});

test("activatable artifacts require a verified result", () => {
  assert.doesNotThrow(() => assertArtifactActivatable({
    status: "verified",
    provenance: validateArtifactProvenance({ ...input, signatureStatus: "verified" }),
  }));
  assert.throws(
    () => assertArtifactActivatable({ status: "unsigned", provenance: validateArtifactProvenance(input) }),
    (error: unknown) => error instanceof ArtifactProvenanceError && error.code === "artifact_provenance_required",
  );
});
