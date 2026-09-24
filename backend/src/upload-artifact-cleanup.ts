import { lstat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BuildPackage } from "./models.js";
import type { PortalUploadArtifactCleanupProfile } from "./portal-compatibility.js";

export const DEFAULT_STALE_UPLOAD_AGE_MS = 24 * 60 * 60_000;
const GENERIC_IMAGE_TEMP_PREFIXES = ["openapp-image-"] as const;

export interface UploadArtifactCleanupResult {
  checked: number;
  removed: number;
  errors: number;
}

/** Removes only expired artifacts created by Portal upload/activation flows. */
export async function cleanupStaleUploadArtifacts(options: {
  releaseRoot: string;
  temporaryRoot?: string;
  staleAfterMs?: number;
  now?: Date;
  buildPackages?: readonly Pick<BuildPackage, "id" | "storageKey">[];
  /** 旧命名空间由兼容边界显式提供；通用调用只使用 OpenApp 前缀。 */
  cleanupProfile?: PortalUploadArtifactCleanupProfile;
}): Promise<UploadArtifactCleanupResult> {
  const now = options.now ?? new Date();
  const staleAfterMs = Number.isFinite(options.staleAfterMs)
    ? Math.max(60_000, options.staleAfterMs!)
    : DEFAULT_STALE_UPLOAD_AGE_MS;
  const cutoff = now.getTime() - staleAfterMs;
  // 通用 Core 默认只清理 OpenApp 命名空间；旧产物必须由兼容边界
  // 显式提供规则，避免新 App 误删另一产品的暂存文件。
  const imageTemporaryPrefixes = [
    ...GENERIC_IMAGE_TEMP_PREFIXES,
    ...(options.cleanupProfile?.imageTemporaryPrefixes ?? []),
  ];
  const releaseArtifactMatchers = options.cleanupProfile?.releaseArtifactMatchers ?? [];
  const results = await Promise.all([
    cleanupRoot(options.temporaryRoot ?? tmpdir(), (name) => isPortalImageTemporary(name, imageTemporaryPrefixes), cutoff),
    cleanupRoot(options.releaseRoot, (name) => isReleaseArtifact(name, releaseArtifactMatchers), cutoff),
    cleanupCatalogUploads(options.releaseRoot, cutoff),
    options.buildPackages
      ? cleanupBuildPackageStorage(options.releaseRoot, options.buildPackages, cutoff)
      : Promise.resolve({ checked: 0, removed: 0, errors: 0 }),
  ]);
  return results.reduce((total, result) => ({
    checked: total.checked + result.checked,
    removed: total.removed + result.removed,
    errors: total.errors + result.errors,
  }), { checked: 0, removed: 0, errors: 0 });
}

async function cleanupBuildPackageStorage(
  releaseRoot: string,
  packages: readonly Pick<BuildPackage, "id" | "storageKey">[],
  cutoff: number,
): Promise<UploadArtifactCleanupResult> {
  const protectedDirectories = new Set(packages
    .filter((pkg) => pkg.storageKey.startsWith(`build-packages/${pkg.id}/`))
    .map((pkg) => pkg.id));
  return cleanupRoot(join(releaseRoot, "build-packages"), (name) => (
    name.startsWith(".openapp-build-package-") || !protectedDirectories.has(name)
  ), cutoff);
}

async function cleanupCatalogUploads(root: string, cutoff: number): Promise<UploadArtifactCleanupResult> {
  const appsRoot = join(root, "apps");
  let apps: string[];
  try {
    apps = await readdir(appsRoot);
  } catch (error) {
    return isMissing(error) ? { checked: 0, removed: 0, errors: 0 } : { checked: 0, removed: 0, errors: 1 };
  }
  const results = await Promise.all(apps
    .filter((appId) => /^[a-z0-9](?:[a-z0-9._-]{0,63})$/u.test(appId))
    .map((appId) => cleanupRoot(join(appsRoot, appId), (name) => name.startsWith(".openapp-upload-"), cutoff)));
  return results.reduce((total, result) => ({
    checked: total.checked + result.checked,
    removed: total.removed + result.removed,
    errors: total.errors + result.errors,
  }), { checked: 0, removed: 0, errors: 0 });
}

async function cleanupRoot(
  root: string,
  matches: (name: string) => boolean,
  cutoff: number,
): Promise<UploadArtifactCleanupResult> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isMissing(error)) return { checked: 0, removed: 0, errors: 0 };
    return { checked: 0, removed: 0, errors: 1 };
  }
  let checked = 0;
  let removed = 0;
  let errors = 0;
  for (const name of names) {
    if (!matches(name)) continue;
    checked += 1;
    const path = join(root, name);
    try {
      const metadata = await lstat(path);
      if (metadata.mtimeMs > cutoff) continue;
      await rm(path, { recursive: metadata.isDirectory(), force: true });
      removed += 1;
    } catch (error) {
      if (!isMissing(error)) errors += 1;
    }
  }
  return { checked, removed, errors };
}

function isReleaseArtifact(name: string, legacyMatchers: readonly RegExp[]): boolean {
  if (name.startsWith(".openapp-upload-") || name.startsWith(".openapp-build-upload-")) return true;
  return legacyMatchers.some((matcher) => matcher.test(name))
    || /^\.\.openapp-active-release\.json\.\d+-[a-f0-9]{8}\.tmp$/u.test(name);
}

function isPortalImageTemporary(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}


function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
