import { APP_ID_PATTERN } from "./app-id.js";
import { packagesForVersion } from "./app-version-packages.js";
import type { AppCatalog } from "./app-catalog.js";
import type { BuildPackageStorage } from "./build-package-upload.js";
import type { ImageBuildExecutor } from "./image-build-executor.js";
import type { ImageBuildManager } from "./image-builds.js";
import type { AppVersion, BuildPackage, ImageArtifact, ImageBuild } from "./models.js";

const PACKAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class AppImageUpdateError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export interface CreateAppImageCandidateInput {
  appId: string;
  strategyId?: string;
  expectedRevision: number;
  replacementPackageIds: unknown;
  requestedBy: string;
  operationId: string;
  signal: AbortSignal;
  report(progress: number, stage: string): Promise<void>;
  commitPoint(): Promise<void>;
}

export interface AppImageCandidate {
  revision: AppVersion;
  build: ImageBuild;
  artifact: ImageArtifact;
  inheritedSlots: string[];
  replacedSlots: string[];
  removedSlots: string[];
}

export interface AppImageUpdateCoordinatorOptions {
  catalog: AppCatalog;
  imageBuilds: ImageBuildManager;
  imageBuildExecutor: ImageBuildExecutor;
  buildPackageStorage: BuildPackageStorage;
  /** 插件注册表提供的默认策略；未注入时通用 Core 必须 fail closed。 */
  defaultStrategyIdForApp?: (appId: string) => string | Promise<string | undefined> | undefined;
  supportsStrategyForApp?: (appId: string, strategyId: string) => boolean;
  /** 已废弃且不影响行为；构建策略由外部 Adapter 显式注册。 */
  legacyCompatibility?: boolean;
}

/**
 * Owns the administrator-facing image update workflow. The candidate is
 * immutable and fully smoke-tested before it can become an App's current image.
 */
export class AppImageUpdateCoordinator {
  readonly #catalog: AppCatalog;
  readonly #imageBuilds: ImageBuildManager;
  readonly #imageBuildExecutor: ImageBuildExecutor;
  readonly #buildPackageStorage: BuildPackageStorage;
  readonly #defaultStrategyIdForApp?: (appId: string) => string | Promise<string | undefined> | undefined;
  readonly #supportsStrategyForApp?: (appId: string, strategyId: string) => boolean;

  constructor(options: AppImageUpdateCoordinatorOptions) {
    this.#catalog = options.catalog;
    this.#imageBuilds = options.imageBuilds;
    this.#imageBuildExecutor = options.imageBuildExecutor;
    this.#buildPackageStorage = options.buildPackageStorage;
    this.#defaultStrategyIdForApp = options.defaultStrategyIdForApp;
    this.#supportsStrategyForApp = options.supportsStrategyForApp;
  }

  async createCandidate(input: CreateAppImageCandidateInput): Promise<AppImageCandidate> {
    const appId = normalizeAppId(input.appId);
    const configuredStrategyId = input.strategyId === undefined
      ? this.#defaultStrategyIdForApp
        ? await this.#defaultStrategyIdForApp(appId)
        : undefined
      : input.strategyId;
    // 通用注册表没有该 App 的策略时必须闭合失败；静默选择产品专用策略会
    // 越过 App 边界，并可能构建错误的 Runtime 镜像。
    if (typeof configuredStrategyId !== "string" || configuredStrategyId.trim() === "") {
      throw new AppImageUpdateError("build_strategy_not_found", 404);
    }
    const strategyId = normalizeStrategyId(configuredStrategyId);
    const permitted = this.#supportsStrategyForApp
      ? this.#supportsStrategyForApp(appId, strategyId)
      : await this.#defaultStrategyIdForApp?.(appId) === strategyId;
    if (!permitted) throw new AppImageUpdateError("build_strategy_app_mismatch", 409);
    const expectedRevision = normalizeRevision(input.expectedRevision);
    const requestedBy = input.requestedBy.trim();
    if (!requestedBy) throw new AppImageUpdateError("app_image_update_actor_required");
    const operationId = input.operationId.trim();
    if (!operationId) throw new AppImageUpdateError("app_image_update_operation_required");

    const strategy = await this.#imageBuilds.requireExecutableStrategy(strategyId);
    const versions = await this.#catalog.listVersions(appId);
    const current = versions.find((version) => version.status === "active")
      ?? versions.find((version) => version.status === "legacy")
      ?? null;
    if ((current?.revision ?? 0) !== expectedRevision) {
      throw new AppImageUpdateError("app_revision_conflict", 409);
    }

    const replacements = normalizeReplacements(input.replacementPackageIds);
    const requirementKeys = new Set(strategy.packageRequirements.map((requirement) => requirement.key));
    if (Object.keys(replacements).some((key) => !requirementKeys.has(key))) {
      throw new AppImageUpdateError("unsupported_build_package", 409);
    }
    const inherited = new Map<string, string>();
    for (const pkg of current ? packagesForVersion(current) : []) {
      if (pkg.packageId) inherited.set(pkg.key, pkg.packageId);
    }
    const effectiveIds: string[] = [];
    const inheritedSlots: string[] = [];
    const replacedSlots: string[] = [];
    const removedSlots: string[] = [];
    for (const requirement of strategy.packageRequirements) {
      const replacement = replacements[requirement.key];
      const inheritedId = inherited.get(requirement.key);
      // null 明确表示移除；缺省表示继承，不能用空字符串混淆两种意图。
      if (replacement === null) {
        if (requirement.required) throw new AppImageUpdateError(`required_build_package_cannot_remove:${requirement.key}`, 409);
        if (inheritedId) removedSlots.push(requirement.key);
        continue;
      }
      const selectedId = replacement ?? inheritedId;
      if (!selectedId) {
        if (requirement.required) {
          throw new AppImageUpdateError(`required_build_package_missing:${requirement.key}`);
        }
        continue;
      }
      effectiveIds.push(selectedId);
      if (replacement && replacement !== inheritedId) replacedSlots.push(requirement.key);
      else if (inheritedId) inheritedSlots.push(requirement.key);
    }
    if (replacedSlots.length === 0 && removedSlots.length === 0) throw new AppImageUpdateError("app_image_update_no_changes", 409);

    await input.report(10, "resolving_packages");
    const selected = await this.#buildPackageStorage.resolveSelection(strategy, effectiveIds);
    await input.report(20, "validating_packages");
    const inspected = await this.#imageBuildExecutor.inspectPackages(
      strategy.id,
      strategy.revision,
      { packagePaths: selected.packagePaths },
    );
    assertInspectionMatchesSelection(inspected.packages, selected.packages);
    const latestVersions = await this.#catalog.listVersions(appId);
    const latestCurrent = latestVersions.find((version) => version.status === "active")
      ?? latestVersions.find((version) => version.status === "legacy")
      ?? null;
    if ((latestCurrent?.revision ?? 0) !== expectedRevision) {
      throw new AppImageUpdateError("app_revision_conflict", 409);
    }
    const selectedByKey = new Map(selected.packages.map((pkg) => [pkg.key, pkg]));
    const revision = await this.#catalog.createRevision(appId, {
      packages: inspected.packages.map((pkg) => ({
        key: pkg.key,
        sourcePath: pkg.sourcePath,
        artifact: pkg.artifact,
        packageId: selectedByKey.get(pkg.key)!.id,
      })),
    });

    await input.report(30, "creating_image_build");
    const build = await this.#imageBuilds.createVersionBuild({
      strategyId: strategy.id,
      strategyRevision: strategy.revision,
      operationId,
      sourceAppVersionId: revision.id,
      requestedBy,
    });
    const built = await this.#imageBuildExecutor.execute(build.id, {
      signal: input.signal,
      report: input.report,
      commitPoint: input.commitPoint,
    });
    const artifact = built.record.artifact;
    if (!artifact) throw new AppImageUpdateError("image_artifact_not_found", 500);
    const boundRevision = await this.#imageBuilds.bindRelease(appId, revision.id, artifact.id);
    await input.report(100, "candidate_ready");
    return {
      revision: boundRevision,
      build: built.record.build,
      artifact,
      inheritedSlots,
      replacedSlots,
      removedSlots,
    };
  }

  bindCandidate(appId: string, revisionId: string, expectedRevision: number): Promise<AppVersion> {
    const normalizedRevisionId = revisionId.trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(normalizedRevisionId)) {
      throw new AppImageUpdateError("invalid_app_revision_id");
    }
    return this.#catalog.activateVersion(
      normalizeAppId(appId),
      normalizedRevisionId,
      normalizeRevision(expectedRevision),
    );
  }
}

function assertInspectionMatchesSelection(
  inspected: Array<{ key: string; artifact: { sha256: string; size: number } }>,
  selected: BuildPackage[],
): void {
  const selectedByKey = new Map(selected.map((pkg) => [pkg.key, pkg]));
  if (inspected.length !== selected.length || inspected.some((pkg) => {
    const selectedPackage = selectedByKey.get(pkg.key);
    return !selectedPackage
      || selectedPackage.artifact.sha256 !== pkg.artifact.sha256
      || selectedPackage.artifact.size !== pkg.artifact.size;
  })) {
    throw new AppImageUpdateError("build_strategy_package_inspection_mismatch", 409);
  }
}

function normalizeAppId(value: string): string {
  const appId = value.trim().toLowerCase();
  if (!APP_ID_PATTERN.test(appId)) throw new AppImageUpdateError("invalid_app_id");
  return appId;
}

function normalizeStrategyId(value: string): string {
  const strategyId = value.trim().toLowerCase();
  if (!PACKAGE_KEY_PATTERN.test(strategyId)) throw new AppImageUpdateError("invalid_build_strategy_id");
  return strategyId;
}

function normalizeRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new AppImageUpdateError("invalid_app_revision");
  return value;
}

function normalizeReplacements(value: unknown): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppImageUpdateError("invalid_build_package_selection");
  }
  const replacements: Record<string, string | null> = Object.create(null);
  for (const [rawKey, rawId] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim().toLowerCase();
    const id = rawId === null ? null : typeof rawId === "string" ? rawId.trim() : "";
    if (!PACKAGE_KEY_PATTERN.test(key) || (id !== null && !PACKAGE_ID_PATTERN.test(id)) || Object.hasOwn(replacements, key)) {
      throw new AppImageUpdateError("invalid_build_package_selection");
    }
    replacements[key] = id;
  }
  if (Object.keys(replacements).length === 0) {
    throw new AppImageUpdateError("app_image_update_replacement_required");
  }
  return replacements;
}
