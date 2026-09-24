import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { basename, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import Busboy from "busboy";
import { validateUploadRequirements } from "@openapp/contracts";
import type { BuildPackage, BuildStrategy } from "./models.js";

const MAX_BUILD_PACKAGE_BYTES = 512 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD = 1024 * 1024;

export class BuildPackageUploadError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(code);
  }
}

export interface UploadedBuildPackage {
  key: string;
  path: string;
  originalName: string;
  size: number;
  sourceVersion?: string | null;
  sourceBuildId?: string | null;
  inspectedAt?: string | null;
}

export interface BuildPackageUpload {
  packages: UploadedBuildPackage[];
  cleanup(): Promise<void>;
}

export interface BuildPackageMetadataStore {
  createPackage(pkg: BuildPackage): Promise<BuildPackage | null>;
  getPackage(id: string): Promise<BuildPackage | null>;
  listPackages(strategyId?: string, key?: string, limit?: number): Promise<BuildPackage[]>;
}

export interface BuildPackageStorageOptions {
  releaseRoot: string;
  store: BuildPackageMetadataStore;
  now?: () => Date;
  randomId?: () => string;
}

/** Owns durable package bytes while the persistence adapter owns metadata. */
export class BuildPackageStorage {
  readonly #releaseRoot: string;
  readonly #store: BuildPackageMetadataStore;
  readonly #now: () => Date;
  readonly #randomId: () => string;

  constructor(options: BuildPackageStorageOptions) {
    this.#releaseRoot = resolve(options.releaseRoot);
    this.#store = options.store;
    this.#now = options.now ?? (() => new Date());
    this.#randomId = options.randomId ?? randomUUID;
  }

  list(strategyId?: string, key?: string, limit?: number): Promise<BuildPackage[]> {
    return this.#store.listPackages(strategyId, key, limit);
  }

  async get(id: string): Promise<BuildPackage> {
    const pkg = await this.#store.getPackage(id);
    if (!pkg) throw new BuildPackageUploadError("build_package_not_found", 404);
    return pkg;
  }

  async persist(
    strategy: BuildStrategy,
    uploadedBy: string,
    upload: BuildPackageUpload,
  ): Promise<BuildPackage[]> {
    assertActiveStrategy(strategy);
    const packages: BuildPackage[] = [];
    for (const item of upload.packages) {
      packages.push(await this.#persistOne(strategy, uploadedBy, item));
    }
    return packages;
  }

  async resolveSelection(
    strategy: BuildStrategy,
    packageIds: readonly string[],
  ): Promise<{ packages: BuildPackage[]; packagePaths: Record<string, string> }> {
    assertActiveStrategy(strategy);
    if (!Array.isArray(packageIds) || packageIds.length > strategy.packageRequirements.length) {
      throw new BuildPackageUploadError("build_package_selection_required");
    }
    const uniqueIds = new Set(packageIds.map((id) => typeof id === "string" ? id.trim() : ""));
    if (uniqueIds.has("") || uniqueIds.size !== packageIds.length) {
      throw new BuildPackageUploadError("invalid_build_package_selection");
    }
    const records = await Promise.all([...uniqueIds].map((id) => this.get(id)));
    const selectedKeys = new Set<string>();
    for (const pkg of records) {
      if (pkg.strategyId !== strategy.id) throw new BuildPackageUploadError("build_package_strategy_mismatch", 409);
      if (selectedKeys.has(pkg.key)) throw new BuildPackageUploadError(`duplicate_build_package:${pkg.key}`);
      selectedKeys.add(pkg.key);
      const requirement = strategy.packageRequirements.find((candidate) => candidate.key === pkg.key);
      if (!requirement) throw new BuildPackageUploadError(`unsupported_build_package:${pkg.key}`, 409);
      if (pkg.artifact.size > packageMaximum(requirement)) {
        throw new BuildPackageUploadError(`build_package_too_large:${pkg.key}`, 413);
      }
      if (!requirement.acceptedExtensions.some((extension) => pkg.artifact.file.toLowerCase().endsWith(extension))) {
        throw new BuildPackageUploadError(`invalid_build_package_extension:${pkg.key}`, 409);
      }
    }
    const missing = strategy.packageRequirements.find((requirement) => requirement.required && !selectedKeys.has(requirement.key));
    if (missing) throw new BuildPackageUploadError(`required_build_package_missing:${missing.key}`);
    const paths = await Promise.all(records.map(async (pkg) => [pkg.key, await this.resolvePath(pkg)] as const));
    return {
      packages: records.sort((left, right) => left.key.localeCompare(right.key)),
      packagePaths: Object.fromEntries(paths),
    };
  }

  async resolvePath(pkg: BuildPackage): Promise<string> {
    const expectedPrefix = `build-packages/${pkg.id}/`;
    if (!pkg.storageKey.startsWith(expectedPrefix) || pkg.storageKey.includes("\\") || pkg.storageKey.includes("..")) {
      throw new BuildPackageUploadError("invalid_build_package_storage_key", 500);
    }
    const path = resolve(this.#releaseRoot, pkg.storageKey);
    if (!path.startsWith(`${this.#releaseRoot}${sep}`)) {
      throw new BuildPackageUploadError("invalid_build_package_storage_key", 500);
    }
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      throw new BuildPackageUploadError("build_package_file_missing", 409);
    }
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== pkg.artifact.size) {
      throw new BuildPackageUploadError("build_package_file_invalid", 409);
    }
    if (await sha256File(path) !== pkg.artifact.sha256) {
      throw new BuildPackageUploadError("build_package_checksum_mismatch", 409);
    }
    return path;
  }

  async #persistOne(
    strategy: BuildStrategy,
    uploadedBy: string,
    item: UploadedBuildPackage,
  ): Promise<BuildPackage> {
    const requirement = strategy.packageRequirements.find((candidate) => candidate.key === item.key);
    if (!requirement) throw new BuildPackageUploadError(`unsupported_build_package:${item.key}`);
    const maximum = packageMaximum(requirement);
    let source;
    try {
      source = await lstat(item.path);
    } catch {
      throw new BuildPackageUploadError("build_package_file_missing", 409);
    }
    if (!source.isFile() || source.isSymbolicLink() || source.size !== item.size) {
      throw new BuildPackageUploadError("build_package_file_invalid", 409);
    }
    if (source.size <= 0) throw new BuildPackageUploadError(`empty_build_package:${item.key}`);
    if (source.size > maximum) throw new BuildPackageUploadError(`build_package_too_large:${item.key}`, 413);
    const file = basename(item.path);
    if (!requirement.acceptedExtensions.some((extension) => file.toLowerCase().endsWith(extension))) {
      throw new BuildPackageUploadError(`invalid_build_package_extension:${item.key}`);
    }
    const actor = uploadedBy.trim();
    if (!actor) throw new BuildPackageUploadError("build_package_actor_required");
    const id = this.#randomId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
      throw new BuildPackageUploadError("invalid_build_package_id", 500);
    }
    const storageRoot = join(this.#releaseRoot, "build-packages");
    const temporaryDirectory = join(storageRoot, `.openapp-build-package-${id}.tmp`);
    const packageDirectory = join(storageRoot, id);
    const temporaryDestination = join(temporaryDirectory, file);
    const packageDestination = join(packageDirectory, file);
    await mkdir(storageRoot, { recursive: true, mode: 0o755 });
    await mkdir(temporaryDirectory, { mode: 0o700 });
    let packageDirectoryCreated = false;
    try {
      const sha256 = await sha256File(item.path);
      await rename(item.path, temporaryDestination);
      await mkdir(packageDirectory, { mode: 0o700 });
      packageDirectoryCreated = true;
      await rename(temporaryDestination, packageDestination);
      await rm(temporaryDirectory, { recursive: true, force: true });
      const pkg: BuildPackage = {
        id,
        strategyId: strategy.id,
        key: item.key,
        artifact: { file, sha256, size: item.size },
        originalName: item.originalName.trim().slice(0, 255),
        storageKey: `build-packages/${id}/${file}`,
        uploadedBy: actor,
        sourceVersion: item.sourceVersion ?? null,
        sourceBuildId: item.sourceBuildId ?? null,
        inspectedAt: item.inspectedAt ?? null,
        createdAt: this.#now().toISOString(),
      };
      const saved = await this.#store.createPackage(pkg);
      if (!saved) throw new BuildPackageUploadError("build_package_exists", 409);
      return saved;
    } catch (error) {
      const cleanup = [rm(temporaryDirectory, { recursive: true, force: true })];
      if (packageDirectoryCreated) cleanup.push(rm(packageDirectory, { recursive: true, force: true }));
      await Promise.allSettled(cleanup);
      throw error;
    }
  }
}

/** Receives exactly the package slots declared by a frozen BuildStrategy. */
export async function receiveBuildPackageUpload(
  request: IncomingMessage,
  releaseRoot: string,
  strategy: BuildStrategy,
): Promise<BuildPackageUpload> {
  assertActiveStrategy(strategy);
  let declared;
  try { declared = validateUploadRequirements(strategy.packageRequirements); }
  catch (error) { throw new BuildPackageUploadError(error instanceof Error ? error.message : "invalid_upload_requirements", 409); }
  const requirements = new Map(declared.map((requirement) => [requirement.key, requirement]));
  if (requirements.size === 0) throw new BuildPackageUploadError("build_strategy_packages_required", 409);
  const packageMaximums = new Map([...requirements].map(([key, requirement]) => [key, packageMaximum(requirement)]));
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  const maximumRequest = [...packageMaximums.values()].reduce((total, maximum) => total + maximum, 0)
    + MAX_MULTIPART_OVERHEAD;
  if (Number.isFinite(declaredLength) && declaredLength > maximumRequest) {
    throw new BuildPackageUploadError("build_package_upload_too_large", 413);
  }

  await mkdir(releaseRoot, { recursive: true, mode: 0o755 });
  const directory = await mkdtemp(join(releaseRoot, ".openapp-build-upload-"));
  const received = new Map<string, { path: string; name: string; bytes: number; truncated: boolean }>();
  const writes: Promise<void>[] = [];
  let failure: BuildPackageUploadError | undefined;
  let parser: ReturnType<typeof Busboy> | undefined;

  try {
    try {
      parser = Busboy({
        headers: request.headers,
        limits: {
          files: requirements.size,
          fields: 0,
          parts: requirements.size + 1,
          fileSize: Math.max(...packageMaximums.values()),
        },
      });
    } catch {
      throw new BuildPackageUploadError("multipart_build_package_upload_required");
    }
    const activeParser = parser;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const abort = (error: unknown) => {
        if (settled) return;
        settled = true;
        request.unpipe(activeParser);
        activeParser.destroy();
        request.resume();
        reject(error);
      };
      activeParser.on("file", (field, file, info) => {
        const requirement = requirements.get(field);
        if (!requirement) {
          failure ??= new BuildPackageUploadError(`unsupported_build_package:${field}`);
          file.resume();
          return;
        }
        if (received.has(field)) {
          failure ??= new BuildPackageUploadError(`duplicate_build_package:${field}`);
          file.resume();
          return;
        }
        const originalName = info.filename.trim();
        const maximum = packageMaximums.get(field)!;
        const extension = requirement.acceptedExtensions.find((candidate) => originalName.toLowerCase().endsWith(candidate));
        if (!extension) {
          failure ??= new BuildPackageUploadError(`invalid_build_package_extension:${field}`);
          file.resume();
          return;
        }
        // 字段只用作映射键，落盘名称由宿主生成，不能控制文件路径。
        const path = join(directory, `${randomUUID()}${extension}`);
        const entry = { path, name: originalName, bytes: 0, truncated: false };
        received.set(field, entry);
        file.on("data", (chunk: Buffer) => { entry.bytes += chunk.length; });
        file.on("limit", () => { entry.truncated = true; });
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            if (entry.bytes > maximum) {
              const error = new BuildPackageUploadError(`build_package_too_large:${field}`, 413);
              failure ??= error;
              abort(error);
              callback(error);
              return;
            }
            callback(null, chunk);
          },
        });
        const writing = pipeline(file, limiter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
        writes.push(writing);
        void writing.catch(abort);
      });
      activeParser.on("field", (field) => { failure ??= new BuildPackageUploadError(`unexpected_build_field:${field}`); });
      activeParser.on("filesLimit", () => { failure ??= new BuildPackageUploadError("build_package_file_limit"); });
      activeParser.on("fieldsLimit", () => { failure ??= new BuildPackageUploadError("build_package_field_limit"); });
      activeParser.on("partsLimit", () => { failure ??= new BuildPackageUploadError("build_package_part_limit"); });
      activeParser.once("error", abort);
      activeParser.once("finish", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      request.once("aborted", () => abort(new BuildPackageUploadError("build_package_upload_aborted")));
      request.once("error", abort);
      request.pipe(activeParser);
    });

    const results = await Promise.allSettled(writes);
    const writeFailure = results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
    if (writeFailure) {
      if (writeFailure instanceof BuildPackageUploadError) throw writeFailure;
      throw new BuildPackageUploadError("build_package_upload_write_failed", 500);
    }
    if (failure) throw failure;
    const missing = strategy.packageRequirements.find((requirement) => requirement.required && !received.has(requirement.key));
    if (missing) throw new BuildPackageUploadError(`required_build_package_missing:${missing.key}`);
    const packages = [...received.entries()]
      .map(([key, value]) => {
        if (!value.name || value.bytes <= 0) throw new BuildPackageUploadError(`empty_build_package:${key}`);
        if (value.truncated || value.bytes > packageMaximums.get(key)!) {
          throw new BuildPackageUploadError(`build_package_too_large:${key}`, 413);
        }
        return { key, path: value.path, originalName: value.name, size: value.bytes };
      })
      .sort((left, right) => left.key.localeCompare(right.key));
    return { packages, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    if (parser) {
      request.unpipe(parser);
      parser.destroy();
      request.resume();
    }
    await Promise.allSettled(writes);
    await rm(directory, { recursive: true, force: true });
    if (failure && !(error instanceof BuildPackageUploadError)) throw failure;
    throw error;
  }
}

/** Receives one strategy slot so backend and web packages can be uploaded separately. */
export function receiveBuildPackageSlotUpload(
  request: IncomingMessage,
  releaseRoot: string,
  strategy: BuildStrategy,
  key: string,
): Promise<BuildPackageUpload> {
  assertActiveStrategy(strategy);
  const requirement = strategy.packageRequirements.find((candidate) => candidate.key === key);
  if (!requirement) throw new BuildPackageUploadError(`unsupported_build_package:${key}`);
  return receiveBuildPackageUpload(request, releaseRoot, {
    ...strategy,
    packageRequirements: [{ ...requirement, required: true }],
  });
}

function assertActiveStrategy(strategy: BuildStrategy): void {
  if (strategy.status !== "active") throw new BuildPackageUploadError("build_strategy_archived", 409);
}

function packageMaximum(requirement: BuildStrategy["packageRequirements"][number]): number {
  const maximum = requirement.maxBytes ?? MAX_BUILD_PACKAGE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > MAX_BUILD_PACKAGE_BYTES) {
    throw new BuildPackageUploadError("invalid_build_package_max_bytes", 409);
  }
  return maximum;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
