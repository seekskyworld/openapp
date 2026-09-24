/** 构建插件公开协议；只传递数据与能力，不依赖 Core 私有模块。 */
export type AppVersionStatus = "legacy" | "uploaded" | "image_ready" | "active" | "archived";

export interface AppArtifact {
  file: string;
  sha256: string;
  size: number;
}

export type BuildStrategyStatus = "active" | "archived";

/** One named package slot required or accepted by an image build strategy. */
export interface BuildPackageRequirement {
  key: string;
  required: boolean;
  acceptedExtensions: string[];
  /** Per-package hard limit. Older durable strategies fall back to the server-wide cap. */
  maxBytes?: number;
}

/** Durable strategy metadata. The runner implementation is selected by id. */
export interface BuildStrategy {
  id: string;
  /** Selects an exact code-owned adapter implementation. */
  revision: number;
  name: string;
  description: string;
  /** Code-owned image startup contract validated after every build and before launch. */
  runtimeContract: string;
  packageRequirements: BuildPackageRequirement[];
  status: BuildStrategyStatus;
  createdAt: string;
  updatedAt: string;
}

/** A reusable package uploaded into build-owned durable storage. */
export interface BuildPackage {
  id: string;
  strategyId: string;
  key: string;
  artifact: AppArtifact;
  originalName: string;
  /** Path relative to OPENAPP_RELEASE_DIR so deployment roots remain movable. */
  storageKey: string;
  uploadedBy: string;
  /** Package-local metadata discovered by strategy inspection; unrelated slots may differ. */
  sourceVersion?: string | null;
  sourceBuildId?: string | null;
  inspectedAt?: string | null;
  createdAt: string;
}

export interface ImageBuildPackage {
  key: string;
  artifact: AppArtifact;
  /** Present when the build consumes an independently uploaded package. */
  packageId?: string;
}

export type ImageBuildStatus = "queued" | "building" | "succeeded" | "failed" | "cancelled";

/** Durable execution record; Docker execution remains behind a strategy runner. */
export interface ImageBuild {
  id: string;
  strategyId: string;
  /** Frozen definition used by the runner even if the registered strategy later changes. */
  strategySnapshot: BuildStrategy;
  operationId: string | null;
  sourceAppVersionId: string | null;
  requestedBy: string;
  packages: ImageBuildPackage[];
  status: ImageBuildStatus;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Immutable output of one successful image build. */
export interface ImageArtifact {
  id: string;
  buildId: string;
  imageReference: string;
  imageId: string;
  runtimeContract: string;
  createdAt: string;
}

/** Immutable build metadata associated with one catalog App. */
export interface AppVersion {
  sourceKind?: "packages" | "image";
  id: string;
  appId: string;
  /** Monotonic internal revision scoped to one App; assigned by persistence for legacy callers. */
  revision?: number;
  version: string;
  buildId: string;
  /** Generic package snapshot. */
  packages?: ImageBuildPackage[];
  /** New build-domain relation; imageReference remains the compatibility snapshot. */
  imageArtifactId?: string | null;
  imageReference: string | null;
  /** Frozen startup contract associated with the selected image. */
  runtimeContract?: string | null;
  status: AppVersionStatus;
  createdAt: string;
  activatedAt: string | null;
}


export class ImageBuildExecutionError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface StrategyBuildInput {
  build: ImageBuild;
  appVersion: AppVersion | null;
  standaloneSource?: StandaloneBuildSource;
  releaseRoot: string;
  signal: AbortSignal;
  report(progress: number, stage: string): Promise<void>;
}

export interface StandaloneBuildSource {
  packagePaths: Readonly<Record<string, string>>;
  /** Optional App identity for generic strategies; legacy callers may omit it. */
  appId?: string;
}

export interface StrategyBuildOutput {
  imageReference: string;
  imageId: string;
  /** Best-effort rollback used only until the artifact commit succeeds. */
  cleanup?(): Promise<void>;
}

export interface StrategyPackageInspectionInput {
  packagePaths: Readonly<Record<string, string>>;
}

export interface InspectedStrategyPackage {
  key: string;
  sourcePath: string;
  artifact: AppArtifact;
  sourceVersion?: string | null;
  sourceBuildId?: string | null;
}

/** Version metadata extracted by reviewed strategy code, never by HTTP routes. */
export interface StrategyPackageInspection {
  version: string;
  buildId: string;
  packages: InspectedStrategyPackage[];
}

/** Code-owned adapter selected by durable strategy id. */
export interface BuildStrategyAdapter {
  readonly id: string;
  readonly revision: number;
  inspectPackage?(key: string, sourcePath: string): Promise<InspectedStrategyPackage>;
  inspectPackages?(input: StrategyPackageInspectionInput): Promise<StrategyPackageInspection>;
  execute(input: StrategyBuildInput): Promise<StrategyBuildOutput>;
}


export interface BuildCommandOptions {
  env: Record<string, string | undefined>;
  signal: AbortSignal;
}

export type BuildCommandRunner = (
  executable: string,
  args: readonly string[],
  options: BuildCommandOptions,
) => Promise<void>;


export interface AdapterBuildArtifacts {
  resolveImage(reference: string): Promise<string | null>;
  validateBuiltImage(reference: string, runtimeContract: string): Promise<void>;
  removeImageIfCurrent(reference: string, expectedImageId: string): Promise<boolean>;
}
export class ReleaseInspectionError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
