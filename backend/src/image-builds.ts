import { randomUUID } from "node:crypto";
import { validateBuildPackageRequirements } from "@openapp/contracts";
import { APP_ID_PATTERN } from "./app-id.js";
import { packagesForVersion, packagesForVersionStrategy } from "./app-version-packages.js";
import type { BuildStrategyRegistry } from "./build-strategies.js";
import { IMAGE_REFERENCE_PATTERN } from "./instance-policy.js";
import type {
  AppArtifact,
  AppVersion,
  BuildPackageRequirement,
  BuildStrategy,
  ImageArtifact,
  ImageBuild,
  ImageBuildPackage,
  ImageBuildStatus,
} from "./models.js";
import type { BuildStore } from "./stores-contracts.js";

const BUILD_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IMMUTABLE_IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const RUNTIME_CONTRACT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MAX_BUILD_PACKAGE_BYTES = 512 * 1024 * 1024;

export interface BuildStrategyRegistration {
  id: string;
  revision?: number;
  name: string;
  description?: string;
  runtimeContract: string;
  packageRequirements: BuildPackageRequirement[];
  status?: BuildStrategy["status"];
}

export interface CreateImageBuildInput {
  strategyId: string;
  /** Prevents a queued request from silently switching to a newer strategy revision. */
  strategyRevision?: number;
  operationId?: string | null;
  sourceAppVersionId?: string | null;
  requestedBy: string;
  packages: ImageBuildPackage[];
}

export type CreateVersionImageBuildInput = Omit<CreateImageBuildInput, "packages"> & {
  sourceAppVersionId: string;
};

export interface ImageBuildOutput {
  imageReference: string;
  imageId: string;
}

export interface ImageBuildRecord {
  build: ImageBuild;
  artifact: ImageArtifact | null;
}

export interface ImageBuildManagerOptions {
  store: BuildStore;
  strategyRegistry: BuildStrategyRegistry;
  /** Initial durable definitions supplied by the registered App plugins. */
  initialStrategies?: readonly BuildStrategy[];
  now?: () => Date;
  randomId?: () => string;
}

export class ImageBuildError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

/** Owns strategy registration, durable build transitions, and Release binding. */
export class ImageBuildManager {
  readonly #store: BuildStore;
  readonly #now: () => Date;
  readonly #randomId: () => string;
  readonly #initialStrategies: readonly BuildStrategy[] | undefined;
  readonly strategyRegistry: BuildStrategyRegistry;

  constructor(options: ImageBuildManagerOptions) {
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
    this.#initialStrategies = options.initialStrategies?.map((strategy) => structuredClone(strategy));
    this.strategyRegistry = options.strategyRegistry;
  }

  async initialize(): Promise<void> {
    // 生产组合根显式传入插件定义；未传入时不猜测任何产品策略。
    // 旧数据库中的策略行仍会被校验和保留，不会被删除。
    const initialStrategies = this.#initialStrategies ?? [];
    for (const strategy of initialStrategies) {
      const current = await this.#store.getStrategy(strategy.id);
      if (!current) {
        this.#assertStrategySupported(strategy);
        await this.#store.saveStrategy(structuredClone(strategy));
      } else if (current.status === "active"
        && (current.revision !== strategy.revision
          || !sameStrategyExecutionContract(current, strategy))) {
        throw new ImageBuildError("build_strategy_definition_mismatch", 500);
      }
    }
    for (const strategy of await this.#store.listStrategies()) {
      if (strategy.status !== "active") continue;
      if (this.strategyRegistry.supports(strategy.id, strategy.revision)) continue;
      if (this.strategyRegistry.has(strategy.id)) {
        throw new ImageBuildError("build_strategy_definition_mismatch", 500);
      }
      this.#assertStrategySupported(strategy);
    }
  }

  async registerStrategy(input: BuildStrategyRegistration): Promise<BuildStrategy> {
    const id = normalizeKey(input.id, "invalid_build_strategy_id");
    const name = input.name.trim();
    if (!name || name.length > 120) throw new ImageBuildError("invalid_build_strategy_name");
    const runtimeContract = normalizeRuntimeContract(input.runtimeContract);
    const packageRequirements = normalizeRequirements(input.packageRequirements);
    const current = await this.#store.getStrategy(id);
    const timestamp = this.#now().toISOString();
    const executionContractChanged = Boolean(current && (
      current.runtimeContract !== runtimeContract
      || !sameRequirements(current.packageRequirements, packageRequirements)
    ));
    const revision = normalizeStrategyRevision(input.revision
      ?? (executionContractChanged ? current!.revision + 1 : current?.revision ?? 1));
    if (current && revision < current.revision
      || current && executionContractChanged && revision <= current.revision) {
      throw new ImageBuildError("build_strategy_revision_not_advanced", 409);
    }
    const strategy: BuildStrategy = {
      id,
      revision,
      name,
      description: input.description?.trim().slice(0, 2_000) ?? "",
      runtimeContract,
      packageRequirements,
      status: input.status ?? "active",
      createdAt: current?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (strategy.status === "active") this.#assertStrategySupported(strategy);
    return this.#store.saveStrategy(strategy);
  }

  listStrategies(): Promise<BuildStrategy[]> {
    return this.#store.listStrategies();
  }

  /** 在读取上传流或创建异步任务前拒绝不可执行的历史策略。 */
  async requireExecutableStrategy(id: string): Promise<BuildStrategy> {
    const strategy = await this.#store.getStrategy(normalizeKey(id, "invalid_build_strategy_id"));
    if (!strategy) throw new ImageBuildError("build_strategy_not_found", 404);
    if (strategy.status !== "active") throw new ImageBuildError("build_strategy_archived", 409);
    this.#assertStrategySupported(strategy);
    return strategy;
  }

  async getBuild(id: string): Promise<ImageBuildRecord> {
    const build = await this.#store.getBuild(id);
    if (!build) throw new ImageBuildError("image_build_not_found", 404);
    return { build, artifact: await this.#store.getArtifactForBuild(build.id) };
  }

  listBuilds(strategyId?: string, limit?: number): Promise<ImageBuild[]> {
    return this.#store.listBuilds(strategyId, limit);
  }

  listArtifacts(limit?: number): Promise<ImageArtifact[]> {
    return this.#store.listArtifacts(limit);
  }

  async createBuild(input: CreateImageBuildInput): Promise<ImageBuild> {
    const strategyId = normalizeKey(input.strategyId, "invalid_build_strategy_id");
    const strategy = await this.#store.getStrategy(strategyId);
    if (!strategy) throw new ImageBuildError("build_strategy_not_found", 404);
    if (input.strategyRevision !== undefined && input.strategyRevision !== strategy.revision) {
      throw new ImageBuildError("build_strategy_revision_conflict", 409);
    }
    if (strategy.status !== "active") throw new ImageBuildError("build_strategy_archived", 409);
    this.#assertStrategySupported(strategy);
    const packages = normalizePackages(input.packages, strategy.packageRequirements);
    for (const item of packages) {
      if (!item.packageId) continue;
      const stored = await this.#store.getPackage(item.packageId);
      if (!stored || stored.strategyId !== strategyId || stored.key !== item.key
        || !samePackageArtifact(stored.artifact, item.artifact)) {
        throw new ImageBuildError("build_package_reference_mismatch", 409);
      }
    }
    const requestedBy = input.requestedBy.trim();
    if (!requestedBy) throw new ImageBuildError("image_build_actor_required");
    const sourceAppVersionId = input.sourceAppVersionId?.trim() || null;
    if (sourceAppVersionId && !await this.#store.getRelease(sourceAppVersionId)) {
      throw new ImageBuildError("app_version_not_found", 404);
    }
    const build: ImageBuild = {
      id: this.#randomId(),
      strategyId,
      strategySnapshot: structuredClone(strategy),
      operationId: input.operationId?.trim() || null,
      sourceAppVersionId,
      requestedBy,
      packages,
      status: "queued",
      error: null,
      createdAt: this.#now().toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    const saved = await this.#store.createBuild(build);
    if (!saved) throw new ImageBuildError("image_build_exists", 409);
    return saved;
  }

  async createVersionBuild(input: CreateVersionImageBuildInput): Promise<ImageBuild> {
    const strategyId = normalizeKey(input.strategyId, "invalid_build_strategy_id");
    const strategy = await this.#store.getStrategy(strategyId);
    if (!strategy) throw new ImageBuildError("build_strategy_not_found", 404);
    if (input.strategyRevision !== undefined && input.strategyRevision !== strategy.revision) {
      throw new ImageBuildError("build_strategy_revision_conflict", 409);
    }
    if (strategy.status !== "active") throw new ImageBuildError("build_strategy_archived", 409);
    this.#assertStrategySupported(strategy);
    const sourceAppVersionId = input.sourceAppVersionId.trim();
    const version = sourceAppVersionId ? await this.#store.getRelease(sourceAppVersionId) : null;
    if (!version) throw new ImageBuildError("app_version_not_found", 404);
    if (version.status === "active" || version.status === "legacy") {
      throw new ImageBuildError("app_version_immutable", 409);
    }
    return this.createBuild({
      ...input,
      strategyId,
      strategyRevision: input.strategyRevision ?? strategy.revision,
      sourceAppVersionId,
      packages: packagesForVersionStrategy(version, strategy),
    });
  }

  async startBuild(id: string): Promise<ImageBuild> {
    const current = await this.#requireBuild(id);
    if (current.status !== "queued") throw invalidTransition(current.status, "building");
    const updated = await this.#store.updateBuild({
      ...current,
      status: "building",
      startedAt: this.#now().toISOString(),
    }, "queued");
    if (!updated) throw new ImageBuildError("image_build_conflict", 409);
    return updated;
  }

  async completeBuild(id: string, output: ImageBuildOutput): Promise<ImageBuildRecord> {
    const current = await this.#requireBuild(id);
    if (current.status !== "building") throw invalidTransition(current.status, "succeeded");
    const imageReference = normalizeImageReference(output.imageReference);
    const imageId = typeof output.imageId === "string" ? output.imageId.trim() : "";
    if (!IMMUTABLE_IMAGE_ID_PATTERN.test(imageId)) throw new ImageBuildError("invalid_image_id");
    const finishedAt = this.#now().toISOString();
    const build: ImageBuild = { ...current, status: "succeeded", error: null, finishedAt };
    const artifact: ImageArtifact = {
      id: this.#randomId(),
      buildId: current.id,
      imageReference,
      imageId,
      runtimeContract: current.strategySnapshot.runtimeContract,
      createdAt: finishedAt,
    };
    const completed = await this.#store.completeBuild(build, artifact, "building");
    if (!completed) throw new ImageBuildError("image_build_conflict", 409);
    return completed;
  }

  failBuild(id: string, error: string): Promise<ImageBuild> {
    const reason = error.trim().slice(0, 2_000) || "image_build_failed";
    return this.#finishBuild(id, "failed", reason);
  }

  cancelBuild(id: string): Promise<ImageBuild> {
    return this.#finishBuild(id, "cancelled", null);
  }

  recoverInterrupted(): Promise<number> {
    return this.#store.recoverInterruptedBuilds(this.#now().toISOString());
  }

  async bindRelease(appId: string, versionId: string, artifactId: string): Promise<AppVersion> {
    const artifact = await this.#store.getArtifact(artifactId);
    if (!artifact) throw new ImageBuildError("image_artifact_not_found", 404);
    const normalizedAppId = appId.trim().toLowerCase();
    if (!APP_ID_PATTERN.test(normalizedAppId)) throw new ImageBuildError("invalid_app_id");
    const app = await this.#store.getApp(normalizedAppId);
    if (!app) throw new ImageBuildError("app_not_found", 404);
    if (app.status !== "active") throw new ImageBuildError("app_archived", 409);
    const release = await this.#store.getRelease(versionId);
    if (!release || release.appId !== normalizedAppId) throw new ImageBuildError("app_version_not_found", 404);
    if (release.status === "active" || release.status === "legacy") {
      throw new ImageBuildError("app_version_immutable", 409);
    }
    const build = await this.#store.getBuild(artifact.buildId);
    if (!build || build.status !== "succeeded"
      || artifact.runtimeContract !== build.strategySnapshot.runtimeContract
      || (build.sourceAppVersionId && build.sourceAppVersionId !== release.id)) {
      throw new ImageBuildError("release_artifact_binding_mismatch", 409);
    }
    if (!releasePackagesMatchBuild(release, build)) {
      throw new ImageBuildError("release_artifact_binding_mismatch", 409);
    }
    const bound = await this.#store.bindRelease(normalizedAppId, versionId, artifactId);
    if (!bound) throw new ImageBuildError("release_artifact_binding_conflict", 409);
    return bound;
  }

  async #finishBuild(id: string, status: "failed" | "cancelled", error: string | null): Promise<ImageBuild> {
    const current = await this.#requireBuild(id);
    if (current.status !== "queued" && current.status !== "building") throw invalidTransition(current.status, status);
    const updated = await this.#store.updateBuild({
      ...current,
      status,
      error,
      finishedAt: this.#now().toISOString(),
    }, current.status);
    if (!updated) throw new ImageBuildError("image_build_conflict", 409);
    return updated;
  }

  async #requireBuild(id: string): Promise<ImageBuild> {
    const build = await this.#store.getBuild(id);
    if (!build) throw new ImageBuildError("image_build_not_found", 404);
    return build;
  }

  #assertStrategySupported(strategy: BuildStrategy): void {
    if (!this.strategyRegistry.supports(strategy.id, strategy.revision)) {
      throw new ImageBuildError("build_strategy_adapter_not_found", 409);
    }
  }
}

function samePackage(left: AppArtifact | undefined, right: AppArtifact): boolean {
  return Boolean(left && left.sha256 === right.sha256 && left.size === right.size);
}

function releasePackagesMatchBuild(release: AppVersion, build: ImageBuild): boolean {
  const releasePackages = packagesForVersion(release);
  const releaseByKey = uniquePackageMap(releasePackages);
  const buildByKey = uniquePackageMap(build.packages);
  if (!releaseByKey || !buildByKey) return false;
  for (const requirement of build.strategySnapshot.packageRequirements) {
    const releasePackage = releaseByKey.get(requirement.key);
    const buildPackage = buildByKey.get(requirement.key);
    if (requirement.required && (!releasePackage || !buildPackage)) return false;
    if (Boolean(releasePackage) !== Boolean(buildPackage)) return false;
    if (releasePackage && buildPackage && !samePackage(buildPackage, releasePackage)) return false;
  }
  return true;
}

function uniquePackageMap(packages: ImageBuildPackage[]): Map<string, AppArtifact> | null {
  const result = new Map<string, AppArtifact>();
  for (const entry of packages) {
    if (result.has(entry.key)) return null;
    result.set(entry.key, entry.artifact);
  }
  return result;
}

function normalizeRequirements(input: BuildPackageRequirement[]): BuildPackageRequirement[] {
  try { return validateBuildPackageRequirements(input); }
  catch (error) { throw new ImageBuildError(error instanceof Error ? error.message : "invalid_build_package_requirement"); }
}

function normalizePackages(input: ImageBuildPackage[], requirements: BuildPackageRequirement[]): ImageBuildPackage[] {
  if (!Array.isArray(input)) throw new ImageBuildError("invalid_image_build_packages");
  const requirementByKey = new Map(requirements.map((requirement) => [requirement.key, requirement]));
  const packages = new Map<string, ImageBuildPackage>();
  for (const item of input) {
    if (!item || typeof item !== "object") throw new ImageBuildError("invalid_image_build_package");
    const key = normalizeKey(item.key, "invalid_build_package_key");
    const requirement = requirementByKey.get(key);
    if (!requirement) throw new ImageBuildError("unsupported_build_package");
    if (packages.has(key)) throw new ImageBuildError("duplicate_build_package");
    const artifact = normalizeArtifact(item.artifact);
    if (!requirement.acceptedExtensions.some((extension) => artifact.file.toLowerCase().endsWith(extension))) {
      throw new ImageBuildError("invalid_build_package_extension");
    }
    if (artifact.size > packageMaximum(requirement)) {
      throw new ImageBuildError("build_package_too_large");
    }
    const packageId = typeof item.packageId === "string" ? item.packageId.trim() : "";
    if (item.packageId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(packageId)) {
      throw new ImageBuildError("invalid_build_package_id");
    }
    packages.set(key, { key, artifact, ...(packageId ? { packageId } : {}) });
  }
  if (requirements.some((requirement) => requirement.required && !packages.has(requirement.key))) {
    throw new ImageBuildError("required_build_package_missing");
  }
  return [...packages.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function normalizeArtifact(input: AppArtifact): AppArtifact {
  const file = typeof input?.file === "string" ? input.file.trim() : "";
  const sha256 = typeof input?.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
  const size = input?.size;
  if (!file || file === "." || file === ".." || file.includes("/") || file.includes("\\")) {
    throw new ImageBuildError("invalid_build_package_file");
  }
  if (!SHA256_PATTERN.test(sha256)) throw new ImageBuildError("invalid_build_package_sha256");
  if (!Number.isSafeInteger(size) || size < 0) throw new ImageBuildError("invalid_build_package_size");
  return { file, sha256, size };
}

function samePackageArtifact(left: AppArtifact, right: AppArtifact): boolean {
  // 入库文件名与 Adapter 的版本内文件名可以不同；包身份由已校验的内容摘要和大小决定。
  return left.sha256 === right.sha256 && left.size === right.size;
}

function sameStrategyExecutionContract(left: BuildStrategy, right: BuildStrategy): boolean {
  return left.id === right.id
    && left.revision === right.revision
    && left.runtimeContract === right.runtimeContract
    && sameRequirements(left.packageRequirements, right.packageRequirements);
}

function sameRequirements(
  left: readonly BuildPackageRequirement[],
  right: readonly BuildPackageRequirement[],
): boolean {
  if (left.length !== right.length) return false;
  const normalizedLeft = [...left].sort((a, b) => a.key.localeCompare(b.key));
  const normalizedRight = [...right].sort((a, b) => a.key.localeCompare(b.key));
  return normalizedLeft.every((requirement, index) => {
    const candidate = normalizedRight[index];
    return candidate?.key === requirement.key
      && candidate.required === requirement.required
      && packageMaximum(candidate) === packageMaximum(requirement)
      && candidate.acceptedExtensions.length === requirement.acceptedExtensions.length
      && [...candidate.acceptedExtensions].sort().every((extension, extensionIndex) => (
        extension === [...requirement.acceptedExtensions].sort()[extensionIndex]
      ));
  });
}

function normalizePackageMaximum(input: number | undefined): number {
  const maxBytes = input ?? MAX_BUILD_PACKAGE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_BUILD_PACKAGE_BYTES) {
    throw new ImageBuildError("invalid_build_package_max_bytes");
  }
  return maxBytes;
}

function packageMaximum(requirement: BuildPackageRequirement): number {
  return normalizePackageMaximum(requirement.maxBytes);
}

function normalizeKey(input: string, code: string): string {
  const key = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!BUILD_KEY_PATTERN.test(key)) throw new ImageBuildError(code);
  return key;
}

function normalizeRuntimeContract(input: string): string {
  const runtimeContract = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (!RUNTIME_CONTRACT_PATTERN.test(runtimeContract)) throw new ImageBuildError("invalid_runtime_contract");
  return runtimeContract;
}

function normalizeStrategyRevision(input: number): number {
  if (!Number.isSafeInteger(input) || input < 1 || input > 1_000_000) {
    throw new ImageBuildError("invalid_build_strategy_revision");
  }
  return input;
}

function normalizeImageReference(input: string): string {
  const reference = typeof input === "string" ? input.trim() : "";
  if (!IMAGE_REFERENCE_PATTERN.test(reference)) throw new ImageBuildError("invalid_image_reference");
  return reference;
}

function invalidTransition(from: ImageBuildStatus, to: ImageBuildStatus): ImageBuildError {
  return new ImageBuildError(`invalid_image_build_transition:${from}:${to}`, 409);
}
