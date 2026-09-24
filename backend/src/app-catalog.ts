import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, rm, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AppCatalogError,
  type AppArtifact,
  type AppDefinition,
  type AppVersion,
} from "./models.js";
import { IMAGE_REFERENCE_PATTERN } from "./instance-policy.js";
import { APP_ID_PATTERN } from "./app-id.js";
import { packagesForVersion } from "./app-version-packages.js";
import type { CatalogStore } from "./stores-contracts.js";
import { appVersionIsValid, buildIdIsValid } from "./release-contract.js";
import { NO_RUNTIME_CONTRACT } from "./runtime-contracts.js";
import { ArtifactOperationError } from "./artifact-provider.js";

const ARTIFACT_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VERSION_MANIFEST_NAME = ".openapp-app-version.json";
const MAX_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 2_000;
const ORPHAN_VERSION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const RUNTIME_CONTRACT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PACKAGE_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const PACKAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export interface AppLaunchTarget {
  app: AppDefinition;
  version: AppVersion;
  imageReference: string;
}

export interface AppVersionPackageSource {
  key: string;
  sourcePath: string;
  artifact: AppArtifact;
  packageId?: string;
}

/**
 * 由 App 插件提供的首次目录引导值。目录本身不推断某个产品的名称、镜像
 * 或运行合同；这些值只用于没有历史目录数据的全新安装。
 */
export interface AppCatalogBootstrap {
  readonly app: Pick<AppDefinition, "id" | "name" | "description" | "authAdapterId">;
  readonly legacyVersion: {
    readonly version: string;
    readonly imageReference: string;
    readonly runtimeContract: string;
  };
}

/** Strategy-inspected metadata and immutable package sources for one App Version. */
export interface InspectedAppVersion {
  version: string;
  buildId: string;
  packages: AppVersionPackageSource[];
}

/** Package snapshot for an internal App Revision. Compatibility version fields are generated server-side. */
export interface InspectedAppRevision {
  packages: AppVersionPackageSource[];
}

export interface AppCatalogOptions {
  store: CatalogStore;
  releaseRoot: string;
  supportsAuthAdapter?: (appId: string) => boolean;
  /** 首次安装时创建的 App；传 null 可显式关闭目录引导。 */
  bootstrap?: AppCatalogBootstrap | null;
  /** 已废弃且不影响行为；目录默认值由外部 Adapter 显式注册。 */
  legacyCompatibility?: boolean;
  /** 为裸镜像绑定选择 App 的运行合同；不提供时使用版本自身合同。 */
  runtimeContractForApp?: (appId: string, version: AppVersion) => string | null | undefined;
  /** Resolves a selectable reference to an immutable runtime image identity. */
  resolveImage?: (reference: string) => Promise<string | null>;
  validateImage?: (reference: string, runtimeContract: string) => Promise<void>;
  validateCandidateImage?: (reference: string, runtimeContract: string) => Promise<void>;
  /** Adapter-owned historical release metadata accepted during package inspection. */
  releaseInspectorForApp?: (appId: string) => import('@openapp/contracts').AdapterReleaseInspector | undefined;
  now?: () => Date;
  withActivationLock?: <T>(operation: () => Promise<T>) => Promise<T>;
  registerNoAuthApp?: (appId: string) => void;
}

/**
 * Deep catalog interface for administrator-managed Apps and immutable builds.
 * Files are stored by App/version, while the database owns activation and
 * provisioning snapshots. Credential adapters remain code-owned and are only
 * referenced by an id accepted by the startup registry.
 */
export class AppCatalog {
  readonly #store: CatalogStore;
  readonly #releaseRoot: string;
  readonly #supportsAuthAdapter: (appId: string) => boolean;
  readonly #bootstrap: AppCatalogBootstrap | null;
  readonly #runtimeContractForApp: (appId: string, version: AppVersion) => string | null | undefined;
  readonly #resolveImage?: (reference: string) => Promise<string | null>;
  readonly #validateImage?: (reference: string, runtimeContract: string) => Promise<void>;
  readonly #validateCandidateImage?: (reference: string, runtimeContract: string) => Promise<void>;
  readonly #now: () => Date;
  readonly #withActivationLock: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly #registerNoAuthApp: (appId: string) => void;
  readonly #releaseInspectorForApp: NonNullable<AppCatalogOptions['releaseInspectorForApp']>;

  constructor(options: AppCatalogOptions) {
    this.#store = options.store;
    this.#releaseInspectorForApp = options.releaseInspectorForApp ?? (() => undefined);
    this.#releaseRoot = options.releaseRoot;
    // 通用目录只接受调用方显式声明的能力；没有插件 bootstrap 时保持为空，
    // 避免因 AppCatalog 被直接构造而隐式创建某个产品。
    this.#supportsAuthAdapter = options.supportsAuthAdapter ?? (() => false);
    this.#bootstrap = options.bootstrap === undefined || options.bootstrap === null
      ? null
      : normalizeBootstrap(options.bootstrap);
    this.#runtimeContractForApp = options.runtimeContractForApp
      ?? ((_appId, version) => version.runtimeContract ?? NO_RUNTIME_CONTRACT);
    this.#resolveImage = options.resolveImage;
    this.#validateImage = options.validateImage;
    this.#validateCandidateImage = options.validateCandidateImage;
    this.#now = options.now ?? (() => new Date());
    this.#withActivationLock = options.withActivationLock ?? (async (operation) => operation());
    this.#registerNoAuthApp = options.registerNoAuthApp ?? (() => undefined);
  }

  async initialize(): Promise<void> {
    const now = this.#timestamp();
    for (const existing of await this.#store.listApps()) {
      if (existing.authAdapterId === "none") {
        if (this.#supportsAuthAdapter(existing.id)) throw new AppCatalogError("auth_adapter_conflict", 500);
        this.#registerNoAuthApp(existing.id);
      }
      else if (existing.authAdapterId !== existing.id || !this.#supportsAuthAdapter(existing.id)) {
        throw new AppCatalogError("unsupported_auth_adapter", 500);
      }
    }
    if (!this.#bootstrap) {
      await this.#withActivationLock(async () => {
        for (const catalogApp of await this.#store.listApps()) {
          const appVersions = await this.#store.listAppVersions(catalogApp.id);
          await this.#cleanupOrphanVersionRoots(catalogApp.id, appVersions);
        }
      });
      return;
    }

    const bootstrap = this.#bootstrap;
    const bootstrapAppId = normalizeAppId(bootstrap.app.id);
    let app = await this.#store.getApp(bootstrapAppId);
    if (!app) {
      const created = await this.#store.createApp({
        id: bootstrapAppId,
        name: normalizeName(bootstrap.app.name),
        description: normalizeDescription(bootstrap.app.description),
        authAdapterId: normalizeAuthAdapter(bootstrap.app.authAdapterId, bootstrapAppId, this.#supportsAuthAdapter),
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      // Another Portal process may win the bootstrap insert. Re-read the
      // durable row instead of treating that expected conflict as startup
      // failure.
      app = created ?? await this.#store.getApp(bootstrapAppId);
    }
    if (!app) throw new AppCatalogError("app_bootstrap_failed", 500);
    const bootstrapUsesCredentialedAdapter = bootstrap.app.authAdapterId !== "none";
    if (app.authAdapterId !== bootstrap.app.authAdapterId
      || (bootstrapUsesCredentialedAdapter
        ? !this.#supportsAuthAdapter(app.id)
        : this.#supportsAuthAdapter(app.id))) {
      throw new AppCatalogError("unsupported_auth_adapter", 500);
    }
    const versions = await this.#withActivationLock(async () => {
      let current: AppVersion[] = [];
      for (const catalogApp of await this.#store.listApps()) {
        const appVersions = await this.#store.listAppVersions(catalogApp.id);
        await this.#cleanupOrphanVersionRoots(catalogApp.id, appVersions);
        if (catalogApp.id === app.id) current = appVersions;
      }
      return current;
    });
    for (let index = 0; index < versions.length; index += 1) {
      const version = versions[index]!;
      if (version.buildId === "bootstrap" && packagesForVersion(version).length === 0 && version.imageReference
        && version.status !== "legacy" && version.status !== "active") {
        const repaired = { ...version, status: "legacy" as const };
        await this.#store.saveAppVersion(repaired);
        versions[index] = repaired;
      }
    }
    const active = versions.find((version) => version.status === "active");
    if (active) {
      if (active.buildId === "bootstrap" && packagesForVersion(active).length === 0) {
        await this.#store.saveAppVersion({ ...active, status: "legacy" });
        return;
      }
      await this.#validateStoredArtifacts(active);
      return;
    }
    if (versions.length > 0) return;
    const bootstrapVersion = bootstrap.legacyVersion.version;
    const bootstrapImage = bootstrap.legacyVersion.imageReference;
    const bootstrapRuntimeContract = bootstrap.legacyVersion.runtimeContract;
    const version = await this.#store.saveAppVersion({
      id: randomUUID(),
      appId: app.id,
      version: appVersionIsValid(bootstrapVersion) ? bootstrapVersion : "0.0.0",
      buildId: "bootstrap",
      packages: [],
      imageReference: bootstrapImage,
      runtimeContract: bootstrapRuntimeContract,
      status: "legacy",
      createdAt: now,
      activatedAt: now,
    });
    if (!version) {
      // A concurrent initializer can insert the one bootstrap version first.
      // The existing row is authoritative and needs no second write.
      const existingVersions = await this.#store.listAppVersions(app.id);
      if (existingVersions.length > 0) return;
      throw new AppCatalogError("app_bootstrap_version_conflict", 500);
    }
  }

  listApps(): Promise<AppDefinition[]> {
    return this.#store.listApps();
  }

  getApp(appId: string): Promise<AppDefinition | null> {
    return this.#store.getApp(normalizeAppId(appId));
  }

  /**
   * Resolve an immutable version snapshot by id, including versions that are
   * no longer active. Instance projections use this rather than selecting the
   * current release so historical instances keep their original version.
   */
  getVersion(versionId: string): Promise<AppVersion | null> {
    return this.#store.getAppVersion(versionId);
  }

  async listVersions(appId: string): Promise<AppVersion[]> {
    const versions = await this.#store.listAppVersions(normalizeAppId(appId));
    return versions.slice().sort(compareAppVersions);
  }

  /** Returns only Apps whose selected version can currently be launched. */
  async listLaunchableApps(): Promise<Array<{
    app: AppDefinition;
    versions: AppVersion[];
    activeVersion: AppVersion;
  }>> {
    const apps = await this.#store.listApps();
    const items: Array<{ app: AppDefinition; versions: AppVersion[]; activeVersion: AppVersion }> = [];
    for (const app of apps) {
      if (app.status !== "active") continue;
      const allVersions = await this.#store.listAppVersions(app.id);
      const selectedStatuses = allVersions.some((version) => version.status === "active") ? ["active"] : ["legacy"];
      const versions = allVersions
        .filter((version) => selectedStatuses.includes(version.status))
        .filter((version) => {
          const imageReference = version.imageReference;
          return Boolean(imageReference && IMAGE_REFERENCE_PATTERN.test(imageReference));
        });
      const launchableVersions: AppVersion[] = [];
      for (const version of versions) {
        const reference = version.imageReference!;
        try {
          await this.#assertImageAvailable(reference, version.runtimeContract ?? null);
          launchableVersions.push(version);
        } catch (error) {
          if (!(error instanceof AppCatalogError)
            || (error.code !== "runtime_image_not_found" && error.code !== "runtime_image_contract_invalid")) throw error;
        }
      }
      const activeVersion = launchableVersions.find((version) => version.status === "active")
        ?? launchableVersions.find((version) => version.status === "legacy");
      if (!activeVersion) continue;
      items.push({ app, versions: launchableVersions, activeVersion });
    }
    return items;
  }

  async createApp(input: { id: unknown; name: unknown; description?: unknown; authAdapterId?: unknown }): Promise<AppDefinition> {
    const id = normalizeAppId(input.id);
    const name = normalizeName(input.name);
    const description = normalizeDescription(input.description);
    const authAdapterId = normalizeAuthAdapter(input.authAdapterId, id, this.#supportsAuthAdapter);
    const now = this.#timestamp();
    const created = await this.#store.createApp({ id, name, description, authAdapterId, status: "active", createdAt: now, updatedAt: now });
    if (!created) throw new AppCatalogError("app_exists", 409);
    if (created.authAdapterId === "none") this.#registerNoAuthApp(created.id);
    return created;
  }

  async updateApp(appId: string, input: { name?: unknown; description?: unknown; status?: unknown }): Promise<AppDefinition> {
    const current = await this.#store.getApp(normalizeAppId(appId));
    if (!current) throw new AppCatalogError("app_not_found", 404);
    const status = input.status === undefined ? current.status : input.status === "active" || input.status === "archived" ? input.status : null;
    if (!status) throw new AppCatalogError("invalid_app_status");
    const updated = await this.#store.updateApp({
      ...current,
      name: input.name === undefined ? current.name : normalizeName(input.name),
      description: input.description === undefined ? current.description : normalizeDescription(input.description),
      status,
      updatedAt: this.#timestamp(),
    });
    if (!updated) throw new AppCatalogError("app_not_found", 404);
    return updated;
  }

  async uploadVersion(appId: string, ...paths: string[]): Promise<AppVersion> {
    const id = normalizeAppId(appId);
    const inspector = this.#releaseInspectorForApp(id);
    if (!inspector?.inspectUpload || !inspector.uploadRequirements || paths.length !== inspector.uploadRequirements.length) throw new AppCatalogError("adapter_release_inspector_missing", 409);
    const input = Object.fromEntries(inspector.uploadRequirements.map((slot, index) => [slot.key, paths[index]!]));
    return this.uploadInspectedVersion(id, await inspector.inspectUpload(input, id));
  }

  async uploadInspectedVersion(appId: string, input: InspectedAppVersion): Promise<AppVersion> {
    const normalizedAppId = normalizeAppId(appId);
    const app = await this.#store.getApp(normalizedAppId);
    if (!app) throw new AppCatalogError("app_not_found", 404);
    if (app.status !== "active") throw new AppCatalogError("app_archived", 409);
    return this.#persistInspectedVersion(app, input);
  }

  async createRevision(appId: string, input: InspectedAppRevision): Promise<AppVersion> {
    const normalizedAppId = normalizeAppId(appId);
    const app = await this.#store.getApp(normalizedAppId);
    if (!app) throw new AppCatalogError("app_not_found", 404);
    if (app.status !== "active") throw new AppCatalogError("app_archived", 409);
    const identity = randomUUID().replaceAll("-", "");
    return this.#persistInspectedVersion(app, {
      // These fields only keep old readers and manifests valid. The public
      // workflow identifies this immutable release by its numeric revision.
      version: `0.0.0-revision.r${identity}`,
      buildId: `revision-${identity}`,
      packages: input.packages,
    }, true);
  }

  async #persistInspectedVersion(app: AppDefinition, input: InspectedAppVersion, allowEmpty = false): Promise<AppVersion> {
    const inspected = normalizeInspectedVersion(input, allowEmpty);
    const versionId = randomUUID();
    const versionRoot = this.#versionRoot(app.id, versionId);
    const stagingRoot = join(this.#releaseRoot, "apps", app.id, `.openapp-upload-${versionId}`);
    try {
      await mkdir(stagingRoot, { recursive: true, mode: 0o755 });
      await chmod(stagingRoot, 0o755);
      await Promise.all(inspected.packages.map((pkg, index) => (
        copyAtomic(pkg.sourcePath, join(stagingRoot, pkg.artifact.file), stagingRoot, `.package-${index}`)
      )));
      for (const pkg of inspected.packages) {
        const copiedPath = join(stagingRoot, pkg.artifact.file);
        const copiedHash = await sha256RegularFile(copiedPath, pkg.artifact.size).catch(() => null);
        if (copiedHash !== pkg.artifact.sha256) throw new AppCatalogError("app_version_artifact_invalid", 409);
      }
      const existing = (await this.#store.listAppVersions(app.id)).find((item) => item.version === inspected.version);
      if (existing) throw new AppCatalogError("app_version_exists", 409);
      const version: AppVersion = {
        id: versionId,
        appId: app.id,
        version: inspected.version,
        buildId: inspected.buildId,
        packages: inspected.packages.map((pkg) => ({
          key: pkg.key,
          artifact: pkg.artifact,
          ...(pkg.packageId ? { packageId: pkg.packageId } : {}),
        })),
        imageReference: null,
        runtimeContract: null,
        status: "uploaded",
        createdAt: this.#timestamp(),
        activatedAt: null,
      };
      await writeVersionManifest(stagingRoot, version);
      const saved = await this.#withActivationLock(async () => {
        // App archival and version upload share the same release lock. Re-read
        // the row inside it so an archive that wins the race cannot receive a
        // new release after the caller's initial validation.
        const currentApp = await this.#store.getApp(app.id);
        if (!currentApp) throw new AppCatalogError("app_not_found", 404);
        if (currentApp.status !== "active") throw new AppCatalogError("app_archived", 409);
        const existing = (await this.#store.listAppVersions(app.id)).find((item) => item.version === inspected.version);
        if (existing) throw new AppCatalogError("app_version_exists", 409);
        await rename(stagingRoot, versionRoot);
        try {
          const persisted = await this.#store.saveAppVersion(version);
          if (!persisted) throw new AppCatalogError("app_version_exists", 409);
          return persisted;
        } catch (error) {
          await rm(versionRoot, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
      });
      if (!saved) throw new AppCatalogError("app_version_exists", 409);
      return saved;
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async attachImage(
    appId: string,
    versionId: string,
    imageReference: unknown,
  ): Promise<AppVersion> {
    return this.#withActivationLock(async () => {
      const normalizedAppId = normalizeAppId(appId);
      const reference = normalizeImageReference(imageReference);
      const app = await this.#store.getApp(normalizedAppId);
      if (!app) throw new AppCatalogError("app_not_found", 404);
      if (app.status !== "active") throw new AppCatalogError("app_archived", 409);
      const version = await this.#store.getAppVersion(versionId);
      if (!version || version.appId !== normalizedAppId) throw new AppCatalogError("app_version_not_found", 404);
      if (version.status === "archived") throw new AppCatalogError("app_version_archived", 409);
      if (version.status === "active" || version.status === "legacy") {
        throw new AppCatalogError("app_version_immutable", 409);
      }
      // 新工作流必须绑定可追溯的 ImageArtifact；裸镜像引用仅保留给没有
      // BuildPackage 身份的历史版本。
      if (version.imageArtifactId != null || packagesForVersion(version).some((pkg) => pkg.packageId)) {
        throw new AppCatalogError("image_artifact_required", 409);
      }
      const runtimeContract = normalizeRuntimeContract(
        this.#runtimeContractForApp(normalizedAppId, version)
          ?? version.runtimeContract
          ?? NO_RUNTIME_CONTRACT,
      );
      const immutableReference = await this.#assertImageAvailable(reference, runtimeContract);
      const saved = await this.#store.saveAppVersion({
        ...version,
        imageArtifactId: null,
        imageReference: immutableReference,
        runtimeContract,
        status: "image_ready",
      });
      if (!saved) throw new AppCatalogError("app_version_not_found", 404);
      return saved;
    });
  }

  /** 导入已存在的镜像，不伪造源码包；只有宿主校验过的不可变镜像可成为候选。 */
  async importImage(appId: string, imageReference: unknown, beforeSave?: () => Promise<void>): Promise<AppVersion> {
    const id = normalizeAppId(appId);
    const app = await this.#store.getApp(id);
    if (!app || app.status !== "active") throw new AppCatalogError("app_not_found", 404);
    if (!this.#resolveImage || !this.#validateImage || !this.#validateCandidateImage) throw new AppCatalogError("runtime_image_validation_unavailable", 501);
    const identity = randomUUID();
    const candidate: AppVersion = {
      id: identity, appId: id, version: `0.0.0-image.r${identity.replaceAll("-", "")}`,
      buildId: `image-${identity}`, sourceKind: "image", packages: [],
      imageReference: null, status: "image_ready", createdAt: this.#timestamp(), activatedAt: null,
    };
    const contract = this.#runtimeContractForApp(id, candidate);
    if (!contract || contract === NO_RUNTIME_CONTRACT) throw new AppCatalogError("runtime_image_contract_unsupported", 409);
    candidate.runtimeContract = normalizeRuntimeContract(contract);
    candidate.imageReference = await this.#assertImageAvailable(normalizeImageReference(imageReference), candidate.runtimeContract);
    if (!/^(sha256:[a-f0-9]{64}|.+@sha256:[a-f0-9]{64})$/u.test(candidate.imageReference)) throw new AppCatalogError("immutable_image_required", 409);
    // 与源码构建产物使用同一运行测试端口，不能仅凭镜像元数据标记可发布。
    await this.#validateCandidateImage(candidate.imageReference, candidate.runtimeContract);
    return this.#withActivationLock(async () => {
      const current = await this.#store.getApp(id);
      if (!current || current.status !== "active") throw new AppCatalogError("app_archived", 409);
      await beforeSave?.();
      const saved = await this.#store.saveAppVersion(candidate);
      if (!saved) throw new AppCatalogError("app_version_exists", 409);
      return saved;
    });
  }

  async activateVersion(appId: string, versionId: string, expectedRevision?: number): Promise<AppVersion> {
    return this.#withActivationLock(() => this.#activateVersion(appId, versionId, expectedRevision));
  }

  async #activateVersion(appId: string, versionId: string, expectedRevision?: number): Promise<AppVersion> {
    const normalizedAppId = normalizeAppId(appId);
    const app = await this.#store.getApp(normalizedAppId);
    if (!app || app.status !== "active") throw new AppCatalogError("app_not_found", 404);
    const version = await this.#store.getAppVersion(versionId);
    if (!version || version.appId !== normalizedAppId) throw new AppCatalogError("app_version_not_found", 404);
    if (version.status === "archived") throw new AppCatalogError("app_version_archived", 409);
    if (version.status === "legacy") throw new AppCatalogError("app_version_immutable", 409);
    if (!version.imageReference || !IMAGE_REFERENCE_PATTERN.test(version.imageReference)) {
      throw new AppCatalogError("app_version_image_required", 409);
    }
    if (version.sourceKind !== "image" && !version.imageArtifactId && packagesForVersion(version).length === 0) {
      throw new AppCatalogError("app_version_release_required", 409);
    }
    await this.#validateStoredArtifacts(version);
    await this.#assertImageAvailable(version.imageReference, version.runtimeContract ?? null);
    const versions = await this.#store.listAppVersions(normalizedAppId);
    const current = versions.find((item) => item.status === "active")
      ?? versions.find((item) => item.status === "legacy")
      ?? null;
    const currentRevision = current?.revision ?? 0;
    if (expectedRevision !== undefined) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
        throw new AppCatalogError("invalid_app_revision");
      }
      if (expectedRevision !== currentRevision) {
        throw new AppCatalogError("app_revision_conflict", 409);
      }
    }
    // The database record is authoritative. Recreate the build manifest so a
    // missing or locally edited file cannot alter the release builder input.
    if (version.sourceKind !== "image") await writeVersionManifest(this.#versionRoot(version.appId, version.id), version);
    const activated = await this.#store.activateAppVersion(
      normalizedAppId,
      versionId,
      expectedRevision === undefined ? undefined : current?.id ?? null,
    );
    if (!activated) {
      if (expectedRevision !== undefined) throw new AppCatalogError("app_revision_conflict", 409);
      throw new AppCatalogError("app_version_not_found", 404);
    }
    return activated;
  }

  async launchTarget(appId: string): Promise<AppLaunchTarget> {
    const normalizedAppId = normalizeAppId(appId);
    const app = await this.#store.getApp(normalizedAppId);
    if (!app || app.status !== "active") throw new AppCatalogError("app_not_found", 404);
    const versions = await this.#store.listAppVersions(normalizedAppId);
    const version = versions.find((item) => item.status === "active") ?? versions.find((item) => item.status === "legacy");
    const imageReference = version?.imageReference ?? null;
    if (!version || !imageReference || !IMAGE_REFERENCE_PATTERN.test(imageReference)) throw new AppCatalogError("app_version_not_ready", 409);
    const immutableReference = await this.#assertImageAvailable(imageReference, version.runtimeContract ?? null);
    return { app, version, imageReference: immutableReference };
  }

  #versionRoot(appId: string, versionId: string): string {
    return join(this.#releaseRoot, "apps", normalizeAppId(appId), normalizeVersionId(versionId));
  }

  async #cleanupOrphanVersionRoots(appId: string, versions: readonly AppVersion[]): Promise<void> {
    const appRoot = join(this.#releaseRoot, "apps", normalizeAppId(appId));
    let entries;
    try {
      entries = await readdir(appRoot, { withFileTypes: true });
    } catch {
      return;
    }
    const known = new Set(versions.map((version) => version.id));
    const cutoff = this.#now().getTime() - ORPHAN_VERSION_RETENTION_MS;
    for (const entry of entries) {
      const name = entry.name;
      if (!name.startsWith(".openapp-upload-") && (!/^[A-Za-z0-9_-]{1,128}$/u.test(name) || known.has(name))) continue;
      const path = join(appRoot, name);
      const info = await lstat(path).catch(() => null);
      if (!info || info.mtimeMs > cutoff) continue;
      await rm(path, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #validateStoredArtifacts(version: AppVersion): Promise<void> {
    if (version.sourceKind === "image") {
      if (packagesForVersion(version).length || !version.imageReference || !version.runtimeContract || version.runtimeContract === NO_RUNTIME_CONTRACT) throw new AppCatalogError("app_version_artifact_invalid", 409);
      return;
    }
    const packages = packagesForVersion(version);
    // 全部可选槽位被移除时，只有已通过构建校验并绑定制品的 Revision 可以激活。
    if (packages.length === 0 && !version.imageArtifactId) {
      throw new AppCatalogError("app_version_release_required", 409);
    }
    const versionRoot = this.#versionRoot(version.appId, version.id);
    try {
      const directory = await lstat(versionRoot);
      if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new AppCatalogError("app_version_artifact_invalid", 409);
      }
    } catch (error) {
      if (error instanceof AppCatalogError) throw error;
      throw new AppCatalogError("app_version_artifact_missing", 409);
    }
    for (const { artifact } of packages) {
      const path = appArtifactPath(this.#releaseRoot, version.appId, version.id, artifact);
      let file;
      try {
        file = await lstat(path);
      } catch {
        throw new AppCatalogError("app_version_artifact_missing", 409);
      }
      if (!file.isFile() || file.isSymbolicLink() || file.size !== artifact.size) {
        throw new AppCatalogError("app_version_artifact_invalid", 409);
      }
      let hash: string;
      try {
        hash = await sha256RegularFile(path, artifact.size);
      } catch {
        throw new AppCatalogError("app_version_artifact_unreadable", 409);
      }
      if (hash !== artifact.sha256) {
        throw new AppCatalogError("app_version_artifact_checksum_mismatch", 409);
      }
    }
  }

  async #assertImageAvailable(reference: string, runtimeContract: string | null): Promise<string> {
    if (!this.#resolveImage) return reference;
    let immutableReference: string | null;
    try {
      immutableReference = await this.#resolveImage(reference);
    } catch (error) {
      if (error instanceof AppCatalogError) throw error;
      if (error instanceof ArtifactOperationError) throw new AppCatalogError(error.code, error.status);
      throw new AppCatalogError("runtime_image_listing_unavailable", 501);
    }
    if (!immutableReference) {
      throw new AppCatalogError("runtime_image_not_found", 409);
    }
    if (runtimeContract && runtimeContract !== NO_RUNTIME_CONTRACT && !this.#validateImage) {
      throw new AppCatalogError("runtime_image_validation_unavailable", 501);
    }
    if (runtimeContract && runtimeContract !== NO_RUNTIME_CONTRACT) {
      try {
        await this.#validateImage!(immutableReference, runtimeContract);
      } catch (error) {
        if (error instanceof AppCatalogError) throw error;
        if (error instanceof ArtifactOperationError) throw new AppCatalogError(error.code, error.status);
        throw new AppCatalogError("runtime_image_contract_invalid", 409);
      }
    }
    return immutableReference;
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

function compareAppVersions(left: AppVersion, right: AppVersion): number {
  const leftHasRevision = Number.isFinite(left.revision);
  const rightHasRevision = Number.isFinite(right.revision);
  if (leftHasRevision !== rightHasRevision) return leftHasRevision ? -1 : 1;
  if (leftHasRevision && rightHasRevision && left.revision !== right.revision) {
    return right.revision! - left.revision!;
  }

  const createdAtDifference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (Number.isFinite(createdAtDifference) && createdAtDifference !== 0) return createdAtDifference;
  return left.id.localeCompare(right.id);
}

function normalizeAppId(value: unknown): string {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!APP_ID_PATTERN.test(id)) throw new AppCatalogError("invalid_app_id");
  return id;
}

function normalizeName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > MAX_NAME_LENGTH) throw new AppCatalogError("invalid_app_name");
  return name;
}

function normalizeDescription(value: unknown): string {
  const description = value === undefined ? "" : typeof value === "string" ? value.trim() : "";
  if (description.length > MAX_DESCRIPTION_LENGTH) throw new AppCatalogError("invalid_app_description");
  return description;
}

function normalizeAuthAdapter(value: unknown, appId: string, supports: (id: string) => boolean): string {
  // Adapter selection is code-owned: a registered App ID gets its reviewed
  // adapter automatically, while every other App uses the fixed no-auth
  // behavior. Callers may still pass an explicit value in internal bootstrap
  // tests, but HTTP/CLI routes do not expose that switch.
  const adapter = value === undefined ? (supports(appId) ? appId : "none") : typeof value === "string" ? value.trim().toLowerCase() : "";
  if (adapter === "none") {
    if (supports(appId)) throw new AppCatalogError("auth_adapter_conflict", 409);
    return adapter;
  }
  if (adapter === appId && supports(appId)) return adapter;
  throw new AppCatalogError("unsupported_auth_adapter", 409);
}

function normalizeBootstrap(input: AppCatalogBootstrap): AppCatalogBootstrap {
  if (!input || typeof input !== "object") throw new AppCatalogError("invalid_app_bootstrap", 500);
  const appId = normalizeAppId(input.app?.id);
  const authAdapterId = typeof input.app?.authAdapterId === "string"
    ? input.app.authAdapterId.trim().toLowerCase()
    : "";
  if (!authAdapterId) throw new AppCatalogError("invalid_app_bootstrap", 500);
  const version = typeof input.legacyVersion?.version === "string"
    ? input.legacyVersion.version.trim()
    : "";
  if (!appVersionIsValid(version)) throw new AppCatalogError("invalid_bootstrap_version", 500);
  return {
    app: {
      id: appId,
      name: normalizeName(input.app.name),
      description: normalizeDescription(input.app.description),
      authAdapterId,
    },
    legacyVersion: {
      version,
      imageReference: normalizeImageReference(input.legacyVersion.imageReference),
      runtimeContract: normalizeRuntimeContract(input.legacyVersion.runtimeContract),
    },
  };
}

function normalizeImageReference(value: unknown): string {
  const reference = typeof value === "string" ? value.trim() : "";
  if (!IMAGE_REFERENCE_PATTERN.test(reference)) throw new AppCatalogError("invalid_image_reference");
  return reference;
}

function normalizeRuntimeContract(value: unknown): string {
  const runtimeContract = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!RUNTIME_CONTRACT_PATTERN.test(runtimeContract)) throw new AppCatalogError("invalid_runtime_contract");
  return runtimeContract;
}

function normalizeInspectedVersion(input: InspectedAppVersion, allowEmpty = false): InspectedAppVersion {
  if (!input || typeof input !== "object" || !appVersionIsValid(input.version)) {
    throw new AppCatalogError("release_version_invalid");
  }
  if (!buildIdIsValid(input.buildId)) throw new AppCatalogError("release_build_id_invalid");
  if (!Array.isArray(input.packages) || (!allowEmpty && input.packages.length === 0) || input.packages.length > 32) {
    throw new AppCatalogError("app_version_release_required", 409);
  }
  const keys = new Set<string>();
  const files = new Set<string>();
  const packages = input.packages.map((pkg) => {
    if (!pkg || typeof pkg !== "object") throw new AppCatalogError("invalid_app_version_package");
    const key = typeof pkg.key === "string" ? pkg.key.trim().toLowerCase() : "";
    if (!PACKAGE_KEY_PATTERN.test(key) || keys.has(key)) throw new AppCatalogError("invalid_app_version_package");
    keys.add(key);
    const file = typeof pkg.artifact?.file === "string" ? pkg.artifact.file.trim() : "";
    const sha256 = typeof pkg.artifact?.sha256 === "string" ? pkg.artifact.sha256.trim().toLowerCase() : "";
    const size = pkg.artifact?.size;
    if (!ARTIFACT_FILE_PATTERN.test(file) || files.has(file)
      || !SHA256_PATTERN.test(sha256) || typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) {
      throw new AppCatalogError("invalid_app_version_package");
    }
    files.add(file);
    const sourcePath = typeof pkg.sourcePath === "string" ? pkg.sourcePath : "";
    if (!sourcePath) throw new AppCatalogError("invalid_app_version_package");
    const packageId = pkg.packageId === undefined ? "" : typeof pkg.packageId === "string" ? pkg.packageId.trim() : "";
    if (pkg.packageId !== undefined && !PACKAGE_ID_PATTERN.test(packageId)) {
      throw new AppCatalogError("invalid_app_version_package");
    }
    return {
      key,
      sourcePath,
      artifact: { file, sha256, size },
      ...(packageId ? { packageId } : {}),
    };
  });
  return { version: input.version, buildId: input.buildId, packages };
}

async function copyAtomic(source: string, target: string, directory: string, prefix: string): Promise<void> {
  const temporary = join(directory, `${prefix}-${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o644);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeVersionManifest(directory: string, version: AppVersion): Promise<void> {
  const target = join(directory, VERSION_MANIFEST_NAME);
  const temporary = join(directory, `.${VERSION_MANIFEST_NAME}.${randomUUID()}.tmp`);
  const payload = {
    appId: version.appId,
    revisionId: version.id,
    versionId: version.id,
    version: version.version,
    buildId: version.buildId,
    packages: packagesForVersion(version),
    runtimeContract: version.runtimeContract ?? null,
  };
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o644);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function sha256RegularFile(path: string, expectedSize: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size !== expectedSize) throw new Error("artifact changed during validation");
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

export function appArtifactPath(releaseRoot: string, appId: string, versionId: string, artifact: AppArtifact): string {
  if (!ARTIFACT_FILE_PATTERN.test(artifact.file)) throw new AppCatalogError("invalid_app_artifact_path", 500);
  return join(releaseRoot, "apps", normalizeAppId(appId), normalizeVersionId(versionId), artifact.file);
}

function normalizeVersionId(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(value)) throw new AppCatalogError("invalid_app_version_id", 500);
  return value;
}

export { appVersionIsValid };
