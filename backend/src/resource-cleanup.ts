import { dirname, resolve, sep } from "node:path";
import { rm } from "node:fs/promises";
import { packagesForVersion } from "./app-version-packages.js";
import type { AppVersion, ImageArtifact, ImageBuild } from "./models.js";
import type { OciArtifactManagementPort } from "./artifact-provider.js";
import type { BuildStore, CatalogStore, InstanceStore } from "./stores-contracts.js";
import type { UpgradeRolloutStore, UpgradeRolloutTargetReference } from "./upgrade-rollouts.js";

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type ResourceCleanupKind = "build_package" | "image_artifact";

export interface ResourceCleanupBlocker {
  type: "active_app_revision" | "retained_rollback_revision" | "app_revision" | "image_build" | "container" | "upgrade_rollout";
  id: string;
  instanceId?: string;
  appId?: string;
  revision?: number;
  status?: string;
}

export type ResourceCleanupItem = {
  kind: "build_package";
  id: string;
  blockers: ResourceCleanupBlocker[];
  metadata: {
    strategyId: string;
    key: string;
    originalName: string;
    sourceVersion: string | null;
    size: number;
  };
} | {
  kind: "image_artifact";
  id: string;
  blockers: ResourceCleanupBlocker[];
  metadata: {
    buildId: string;
    imageReference: string;
    imageId: string;
    runtimeContract: string;
  };
};

export interface ResourceCleanupPreview {
  retention: { previousRevisions: number };
  buildPackages: ResourceCleanupItem[];
  imageArtifacts: ResourceCleanupItem[];
  candidates: Array<{ kind: ResourceCleanupKind; id: string }>;
}

export interface ResourceCleanupRun {
  retention: { previousRevisions: number };
  retiredRevisionIds: string[];
  releasedBuildIds: string[];
  deletedBuildPackageIds: string[];
  deletedImageArtifactIds: string[];
  storageCleanupFailedIds: string[];
}

export class ResourceCleanupError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
    readonly blockers: ResourceCleanupBlocker[] = [],
  ) {
    super(code);
  }
}

export interface ResourceCleanupManagerOptions {
  catalog: CatalogStore;
  builds: BuildStore;
  instances: InstanceStore;
  rollouts: Pick<UpgradeRolloutStore, "listActiveTargetReferences">;
  artifacts: Pick<OciArtifactManagementPort, "removeImageIfCurrent">;
  releaseRoot: string;
}

/** Previews and performs only reference-safe package/image deletion. */
export class ResourceCleanupManager {
  readonly #catalog: CatalogStore;
  readonly #builds: BuildStore;
  readonly #instances: InstanceStore;
  readonly #rollouts: Pick<UpgradeRolloutStore, "listActiveTargetReferences">;
  readonly #artifacts: Pick<OciArtifactManagementPort, "removeImageIfCurrent">;
  readonly #releaseRoot: string;

  constructor(options: ResourceCleanupManagerOptions) {
    this.#catalog = options.catalog;
    this.#builds = options.builds;
    this.#instances = options.instances;
    this.#rollouts = options.rollouts;
    this.#artifacts = options.artifacts;
    this.#releaseRoot = resolve(options.releaseRoot);
  }

  async preview(previousRevisions = 1): Promise<ResourceCleanupPreview> {
    if (!Number.isSafeInteger(previousRevisions) || previousRevisions < 1 || previousRevisions > 20) {
      throw new ResourceCleanupError("invalid_cleanup_retention");
    }
    const [apps, buildPackages, builds, imageArtifacts, containers, activeRolloutTargets] = await Promise.all([
      this.#catalog.listApps(),
      this.#builds.listPackages(),
      this.#builds.listBuilds(),
      this.#builds.listArtifacts(),
      this.#instances.listContainers(),
      this.#rollouts.listActiveTargetReferences(),
    ]);
    const versionsByApp = await Promise.all(apps.map(async (app) => ({
      app,
      versions: await this.#catalog.listAppVersions(app.id),
    })));
    const versionsById = new Map(versionsByApp.flatMap(({ versions }) => versions.map((version) => [version.id, version])));
    const retainedRevisionIds = new Set<string>();
    const currentRevisionIds = new Set<string>();
    for (const { versions } of versionsByApp) {
      const current = versions.find((version) => version.status === "active")
        ?? versions.find((version) => version.status === "legacy")
        ?? null;
      if (!current) continue;
      currentRevisionIds.add(current.id);
      versions
        .filter((version) => version.id !== current.id
          && version.status === "image_ready"
          && Boolean(version.imageReference)
          && Boolean(version.revision))
        .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))
        .slice(0, previousRevisions)
        .forEach((version) => retainedRevisionIds.add(version.id));
    }

    const packageItems = buildPackages.map((pkg): ResourceCleanupItem => ({
      kind: "build_package",
      id: pkg.id,
      metadata: {
        strategyId: pkg.strategyId,
        key: pkg.key,
        originalName: pkg.originalName,
        sourceVersion: pkg.sourceVersion ?? null,
        size: pkg.artifact.size,
      },
      blockers: [
        ...versionsByApp.flatMap(({ app, versions }) => versions.flatMap((version) => (
          packagesForVersion(version).some((item) => item.packageId === pkg.id)
            ? [
              revisionBlocker(app.id, version, currentRevisionIds, retainedRevisionIds),
              ...upgradeRolloutBlockers(activeRolloutTargets.filter((target) => targetMatchesVersion(target, version))),
            ]
            : []
        ))),
        ...builds.flatMap((build) => build.packages.some((item) => item.packageId === pkg.id)
          ? [{ type: "image_build" as const, id: build.id, status: build.status }]
          : []),
      ],
    }));
    const artifactItems = imageArtifacts.map((artifact): ResourceCleanupItem => ({
      kind: "image_artifact",
      id: artifact.id,
      metadata: {
        buildId: artifact.buildId,
        imageReference: artifact.imageReference,
        imageId: artifact.imageId,
        runtimeContract: artifact.runtimeContract,
      },
      blockers: [
        ...versionsByApp.flatMap(({ app, versions }) => versions.flatMap((version) => (
          version.imageArtifactId === artifact.id
            ? [revisionBlocker(app.id, version, currentRevisionIds, retainedRevisionIds)]
            : []
        ))),
        ...containers.flatMap((container) => container.imageArtifactId === artifact.id
          ? [{ type: "container" as const, id: container.id, appId: container.appId, status: container.status }]
          : []),
        ...builds.flatMap((build) => {
          if (build.id !== artifact.buildId || !build.sourceAppVersionId) return [];
          const source = versionsById.get(build.sourceAppVersionId);
          return source?.status === "uploaded" && source.imageArtifactId !== artifact.id
            ? [{ type: "image_build" as const, id: build.id, appId: source.appId, revision: source.revision, status: build.status }]
            : [];
        }),
        ...upgradeRolloutBlockers(activeRolloutTargets.filter((target) => (
          targetMatchesArtifact(target, artifact, versionsById)
        ))),
      ],
    }));
    return {
      retention: { previousRevisions },
      buildPackages: packageItems,
      imageArtifacts: artifactItems,
      candidates: [...packageItems, ...artifactItems]
        .filter((item) => item.blockers.length === 0)
        .map((item) => ({ kind: item.kind, id: item.id })),
    };
  }

  async prune(previousRevisions = 1): Promise<ResourceCleanupRun> {
    if (!Number.isSafeInteger(previousRevisions) || previousRevisions < 1 || previousRevisions > 20) {
      throw new ResourceCleanupError("invalid_cleanup_retention");
    }
    const [apps, containers, builds, imageArtifacts, activeRolloutTargets] = await Promise.all([
      this.#catalog.listApps(),
      this.#instances.listContainers(),
      this.#builds.listBuilds(),
      this.#builds.listArtifacts(),
      this.#rollouts.listActiveTargetReferences(),
    ]);
    const containerRevisionIds = new Set(containers.flatMap((container) => (
      container.appVersionId ? [container.appVersionId] : []
    )));
    const artifactsByBuildId = new Map(imageArtifacts.map((artifact) => [artifact.buildId, artifact]));
    const retiredRevisionIds: string[] = [];
    const releasedBuildIds: string[] = [];
    const packageIds = new Set<string>();
    const artifactIds = new Set<string>();
    const storageCleanupFailedIds = new Set<string>();

    for (const app of apps) {
      const versions = await this.#catalog.listAppVersions(app.id);
      // Archiving and filesystem cleanup cannot commit atomically. Retry old
      // archived Revisions so a transient rm failure is repaired next run.
      for (const version of versions) {
        if (version.status === "archived"
          && !await this.#removeRevisionStorage(app.id, version.id)) {
          storageCleanupFailedIds.add(version.id);
        }
      }
      const current = versions.find((version) => version.status === "active")
        ?? versions.find((version) => version.status === "legacy")
        ?? null;
      if (!current?.revision) continue;
      const retained = new Set(versions
        .filter((version) => version.id !== current.id
          && version.status === "image_ready"
          && Boolean(version.imageReference)
          && Boolean(version.revision))
        .sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))
        .slice(0, previousRevisions)
        .map((version) => version.id));
      const eligible = versions.filter((version) => (
        version.id !== current.id
        && !retained.has(version.id)
        && !containerRevisionIds.has(version.id)
        && !activeRolloutTargets.some((target) => targetMatchesVersion(target, version))
        && !hasProtectedBuild(version, builds, artifactsByBuildId)
        && Boolean(version.revision)
        && version.status !== "active"
        && version.status !== "legacy"
        && version.status !== "archived"
        && (version.status === "image_ready" || hasTerminalBuild(version.id, builds))
      ));

      for (const version of eligible) {
        const packages = packagesForVersion(version);
        packages.forEach((pkg) => { if (pkg.packageId) packageIds.add(pkg.packageId); });
        if (version.imageArtifactId) artifactIds.add(version.imageArtifactId);
        const saved = await this.#catalog.saveAppVersion({
          ...version,
          packages: packages.map((pkg) => ({ key: pkg.key, artifact: pkg.artifact })),
          imageArtifactId: null,
          imageReference: null,
          runtimeContract: null,
          status: "archived",
          activatedAt: null,
        });
        if (!saved) continue;
        retiredRevisionIds.push(saved.id);
        if (!await this.#removeRevisionStorage(app.id, saved.id)) {
          storageCleanupFailedIds.add(saved.id);
        }
      }
    }

    const retired = new Set(retiredRevisionIds);
    for (const build of builds) {
      if (!build.sourceAppVersionId || !retired.has(build.sourceAppVersionId)
        || build.status === "queued" || build.status === "building") continue;
      const buildPackageIds = build.packages.flatMap((pkg) => pkg.packageId ? [pkg.packageId] : []);
      if (buildPackageIds.length === 0) continue;
      const released = await this.#builds.updateBuild({
        ...build,
        packages: build.packages.map((pkg) => ({ key: pkg.key, artifact: pkg.artifact })),
      }, build.status);
      if (!released) continue;
      buildPackageIds.forEach((id) => packageIds.add(id));
      releasedBuildIds.push(released.id);
    }

    const deletedImageArtifactIds: string[] = [];
    for (const id of artifactIds) {
      try {
        await this.#deleteImageArtifact(id, true);
        deletedImageArtifactIds.push(id);
      } catch (error) {
        if (!(error instanceof ResourceCleanupError)
          || (error.code !== "resource_in_use" && error.code !== "image_artifact_not_found")) throw error;
      }
    }
    const deletedBuildPackageIds: string[] = [];
    for (const id of packageIds) {
      try {
        await this.#deleteBuildPackage(id, true);
        deletedBuildPackageIds.push(id);
      } catch (error) {
        if (!(error instanceof ResourceCleanupError)
          || (error.code !== "resource_in_use" && error.code !== "build_package_not_found")) throw error;
      }
    }
    return {
      retention: { previousRevisions },
      retiredRevisionIds,
      releasedBuildIds,
      deletedBuildPackageIds,
      deletedImageArtifactIds,
      storageCleanupFailedIds: [...storageCleanupFailedIds],
    };
  }

  async deleteBuildPackage(id: string): Promise<{ id: string; storageRemoved: boolean }> {
    return this.#deleteBuildPackage(id, false);
  }

  async #deleteBuildPackage(id: string, skipInitialPreview: boolean): Promise<{ id: string; storageRemoved: boolean }> {
    const normalizedId = normalizeResourceId(id);
    const pkg = await this.#builds.getPackage(normalizedId);
    if (!pkg) throw new ResourceCleanupError("build_package_not_found", 404);
    if (!skipInitialPreview) {
      const preview = await this.preview();
      const blockers = preview.buildPackages.find((item) => item.id === normalizedId)?.blockers ?? [];
      if (blockers.length > 0) throw new ResourceCleanupError("resource_in_use", 409, blockers);
    }
    const deleted = await this.#builds.deleteBuildPackageIfUnreferenced(normalizedId);
    if (!deleted) {
      if (skipInitialPreview) throw new ResourceCleanupError("resource_in_use", 409);
      const current = await this.preview();
      throw new ResourceCleanupError(
        "resource_in_use",
        409,
        current.buildPackages.find((item) => item.id === normalizedId)?.blockers ?? [],
      );
    }
    const expectedRoot = resolve(this.#releaseRoot, "build-packages", deleted.id);
    const artifactPath = resolve(this.#releaseRoot, deleted.storageKey);
    const storagePathIsValid = artifactPath.startsWith(`${this.#releaseRoot}${sep}`)
      && dirname(artifactPath) === expectedRoot;
    const storageRemoved = storagePathIsValid
      ? await rm(expectedRoot, { recursive: true, force: true }).then(() => true, () => false)
      : false;
    return { id: deleted.id, storageRemoved };
  }

  async deleteImageArtifact(id: string): Promise<{ id: string; runtimeImageRemoved: boolean }> {
    return this.#deleteImageArtifact(id, false);
  }

  async #deleteImageArtifact(id: string, skipInitialPreview: boolean): Promise<{ id: string; runtimeImageRemoved: boolean }> {
    const normalizedId = normalizeResourceId(id);
    const artifact = await this.#builds.getArtifact(normalizedId);
    if (!artifact) throw new ResourceCleanupError("image_artifact_not_found", 404);
    if (!skipInitialPreview) {
      const preview = await this.preview();
      const blockers = preview.imageArtifacts.find((item) => item.id === normalizedId)?.blockers ?? [];
      if (blockers.length > 0) throw new ResourceCleanupError("resource_in_use", 409, blockers);
    }
    const deleted = await this.#builds.deleteImageArtifactIfUnreferenced(normalizedId);
    if (!deleted) {
      if (skipInitialPreview) throw new ResourceCleanupError("resource_in_use", 409);
      const current = await this.preview();
      throw new ResourceCleanupError(
        "resource_in_use",
        409,
        current.imageArtifacts.find((item) => item.id === normalizedId)?.blockers ?? [],
      );
    }
    const runtimeImageRemoved = await this.#artifacts
      .removeImageIfCurrent(deleted.imageReference, deleted.imageId)
      .catch(() => false);
    return { id: deleted.id, runtimeImageRemoved };
  }

  async #removeRevisionStorage(appId: string, revisionId: string): Promise<boolean> {
    const appsRoot = resolve(this.#releaseRoot, "apps");
    const appRoot = resolve(appsRoot, appId);
    const revisionRoot = resolve(appRoot, revisionId);
    if (!appRoot.startsWith(`${appsRoot}${sep}`)
      || !revisionRoot.startsWith(`${appRoot}${sep}`)) return false;
    return rm(revisionRoot, { recursive: true, force: true }).then(() => true, () => false);
  }
}

function revisionBlocker(
  appId: string,
  version: { id: string; revision?: number; status: string },
  currentRevisionIds: ReadonlySet<string>,
  retainedRevisionIds: ReadonlySet<string>,
): ResourceCleanupBlocker {
  const type = currentRevisionIds.has(version.id)
    ? "active_app_revision"
    : retainedRevisionIds.has(version.id)
      ? "retained_rollback_revision"
      : "app_revision";
  return { type, id: version.id, appId, revision: version.revision, status: version.status };
}

function upgradeRolloutBlockers(
  references: readonly UpgradeRolloutTargetReference[],
): ResourceCleanupBlocker[] {
  return references.map((reference) => ({
    type: "upgrade_rollout",
    id: reference.rolloutId,
    instanceId: reference.instanceId,
    appId: reference.appId,
    status: reference.status,
  }));
}

function targetMatchesVersion(reference: UpgradeRolloutTargetReference, version: AppVersion): boolean {
  return reference.sourceAppVersionId === version.id
    || (version.imageArtifactId !== null && version.imageArtifactId !== undefined
      && reference.sourceImageArtifactId === version.imageArtifactId)
    || (version.imageReference !== null && reference.sourceImageReference === version.imageReference)
    || reference.targetAppVersionId === version.id
    || (version.imageArtifactId !== null && version.imageArtifactId !== undefined
      && reference.targetImageArtifactId === version.imageArtifactId)
    || (version.imageReference !== null && reference.targetImageReference === version.imageReference);
}

function targetMatchesArtifact(
  reference: UpgradeRolloutTargetReference,
  artifact: ImageArtifact,
  versionsById: ReadonlyMap<string, AppVersion>,
): boolean {
  if (reference.sourceImageArtifactId === artifact.id
    || reference.sourceImageReference === artifact.imageReference
    || reference.sourceImageReference === artifact.imageId
    || reference.targetImageArtifactId === artifact.id
    || reference.targetImageReference === artifact.imageReference
    || reference.targetImageReference === artifact.imageId) return true;
  const versions = [reference.sourceAppVersionId, reference.targetAppVersionId]
    .flatMap((id) => id ? [versionsById.get(id)] : [])
    .filter((version): version is AppVersion => version !== undefined);
  return versions.some((version) => version.imageArtifactId === artifact.id
    || version.imageReference === artifact.imageReference
    || version.imageReference === artifact.imageId);
}

function hasProtectedBuild(
  version: AppVersion,
  builds: readonly ImageBuild[],
  artifactsByBuildId: ReadonlyMap<string, ImageArtifact>,
): boolean {
  return builds.some((build) => {
    if (build.sourceAppVersionId !== version.id) return false;
    if (build.status === "queued" || build.status === "building") return true;
    if (build.status !== "succeeded") return false;
    const artifact = artifactsByBuildId.get(build.id);
    return Boolean(artifact && version.imageArtifactId !== artifact.id);
  });
}

function hasTerminalBuild(versionId: string, builds: readonly ImageBuild[]): boolean {
  return builds.some((build) => build.sourceAppVersionId === versionId
    && (build.status === "failed" || build.status === "cancelled"));
}

function normalizeResourceId(value: string): string {
  const id = value.trim();
  if (!RESOURCE_ID_PATTERN.test(id)) throw new ResourceCleanupError("invalid_resource_id");
  return id;
}
