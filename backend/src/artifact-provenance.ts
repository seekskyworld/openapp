/**
 * 发布制品来源证明的领域合同。该模块只验证和编排元数据，不假装提供签名服务；
 * 真实 Sigstore、KMS 或内部构建服务通过 verifier 端口接入，旧制品可明确标记 unsigned。
 */

export type ArtifactSignatureStatus = "unsigned" | "verified" | "rejected" | "unavailable";

export interface ArtifactProvenanceInput {
  digest: string;
  builderIdentity: string;
  sourceRevision: string;
  sbomReference?: string;
  provenanceReference?: string;
  signatureStatus?: ArtifactSignatureStatus;
}

export interface ArtifactProvenance {
  digest: string;
  builderIdentity: string;
  sourceRevision: string;
  sbomReference?: string;
  provenanceReference?: string;
  signatureStatus: ArtifactSignatureStatus;
}

export type ArtifactVerificationResult =
  | { status: "verified"; provenance: ArtifactProvenance }
  | { status: "unsigned"; provenance: ArtifactProvenance }
  | { status: "rejected"; provenance: ArtifactProvenance; reason: string }
  | { status: "unavailable"; provenance: ArtifactProvenance; reason: string };

export class ArtifactProvenanceError extends Error {
  readonly status: 409 | 503;

  constructor(
    readonly code:
      | "artifact_provenance_invalid"
      | "artifact_provenance_rejected"
      | "artifact_provenance_unavailable"
      | "artifact_provenance_required",
    readonly field?: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ArtifactProvenanceError";
    this.status = code === "artifact_provenance_unavailable" ? 503 : 409;
  }
}

export interface ArtifactProvenanceVerifier {
  verify(provenance: ArtifactProvenance, signal?: AbortSignal): Promise<ArtifactVerificationResult>;
}

const SIGNATURE_STATUSES = new Set<ArtifactSignatureStatus>([
  "unsigned",
  "verified",
  "rejected",
  "unavailable",
]);
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MAX_REFERENCE_LENGTH = 1024;

export function validateArtifactProvenance(input: ArtifactProvenanceInput): ArtifactProvenance {
  if (!input || typeof input !== "object") throw new ArtifactProvenanceError("artifact_provenance_invalid");
  const digest = normalizedDigest(input.digest);
  const builderIdentity = reference(input.builderIdentity, "builderIdentity");
  const sourceRevision = reference(input.sourceRevision, "sourceRevision");
  const sbomReference = optionalReference(input.sbomReference, "sbomReference");
  const provenanceReference = optionalReference(input.provenanceReference, "provenanceReference");
  const signatureStatus = input.signatureStatus ?? "unsigned";
  if (!SIGNATURE_STATUSES.has(signatureStatus)) {
    throw new ArtifactProvenanceError("artifact_provenance_invalid", "signatureStatus");
  }
  if (signatureStatus === "verified" && !provenanceReference) {
    throw new ArtifactProvenanceError("artifact_provenance_invalid", "provenanceReference");
  }
  return {
    digest,
    builderIdentity,
    sourceRevision,
    ...(sbomReference ? { sbomReference } : {}),
    ...(provenanceReference ? { provenanceReference } : {}),
    signatureStatus,
  };
}

export async function verifyArtifactProvenance(
  input: ArtifactProvenanceInput,
  verifier: ArtifactProvenanceVerifier | undefined,
  options: { requireVerified?: boolean; signal?: AbortSignal } = {},
): Promise<ArtifactVerificationResult> {
  const provenance = validateArtifactProvenance(input);
  options.signal?.throwIfAborted();
  if (!verifier) {
    // 元数据中的 signatureStatus 只是历史提示，不能代替真实验签；否则任何
    // 上传方都可以把 unsigned 制品标成 verified 绕过激活门槛。
    if (provenance.signatureStatus === "unsigned") {
      if (options.requireVerified) throw new ArtifactProvenanceError("artifact_provenance_required");
      return { status: "unsigned", provenance };
    }
    throw new ArtifactProvenanceError("artifact_provenance_unavailable");
  }
  let result: ArtifactVerificationResult;
  try {
    result = await verifier.verify(provenance, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new ArtifactProvenanceError("artifact_provenance_unavailable", undefined, { cause: error });
  }
  options.signal?.throwIfAborted();
  result = normalizeVerificationResult(result, provenance);
  if (options.requireVerified && result.status !== "verified") {
    throw new ArtifactProvenanceError(
      result.status === "unavailable" ? "artifact_provenance_unavailable" : "artifact_provenance_rejected",
    );
  }
  return result;
}

export function assertArtifactActivatable(result: ArtifactVerificationResult): void {
  if (result.status === "verified") return;
  if (result.status === "unavailable") throw new ArtifactProvenanceError("artifact_provenance_unavailable");
  if (result.status === "unsigned") throw new ArtifactProvenanceError("artifact_provenance_required");
  throw new ArtifactProvenanceError("artifact_provenance_rejected");
}

function normalizedDigest(value: unknown): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value.trim().toLowerCase())) {
    throw new ArtifactProvenanceError("artifact_provenance_invalid", "digest");
  }
  return value.trim().toLowerCase();
}

function reference(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ArtifactProvenanceError("artifact_provenance_invalid", field);
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_REFERENCE_LENGTH || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new ArtifactProvenanceError("artifact_provenance_invalid", field);
  }
  return normalized;
}

function optionalReference(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return reference(value, field);
}

function normalizeVerificationResult(
  result: ArtifactVerificationResult,
  expected: ArtifactProvenance,
): ArtifactVerificationResult {
  if (!result || typeof result !== "object" || !SIGNATURE_STATUSES.has(result.status)) {
    throw new ArtifactProvenanceError("artifact_provenance_rejected");
  }
  let returned: ArtifactProvenance;
  try {
    returned = validateArtifactProvenance({
      ...result.provenance,
      // The verifier's decision is authoritative for the returned status;
      // the stored hint must not be allowed to downgrade/upgrade it.
      signatureStatus: result.status,
    });
  } catch (error) {
    if (error instanceof ArtifactProvenanceError) {
      throw new ArtifactProvenanceError("artifact_provenance_rejected", error.field, { cause: error });
    }
    throw new ArtifactProvenanceError("artifact_provenance_rejected", undefined, { cause: error });
  }
  const sameReference = (left: string | undefined, right: string | undefined) => left === right;
  if (
    returned.digest !== expected.digest
    || returned.builderIdentity !== expected.builderIdentity
    || returned.sourceRevision !== expected.sourceRevision
    || !sameReference(returned.sbomReference, expected.sbomReference)
    || !sameReference(returned.provenanceReference, expected.provenanceReference)
  ) {
    throw new ArtifactProvenanceError("artifact_provenance_rejected", "provenance");
  }
  if (result.status === "verified") return { status: "verified", provenance: returned };
  const candidateReason = "reason" in result ? result.reason : undefined;
  const reason = typeof candidateReason === "string" && candidateReason.length > 0 && candidateReason.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(candidateReason)
    ? candidateReason
    : "verifier_rejected";
  return { status: result.status, provenance: returned, reason };
}
