import type { AppVersion, BuildStrategy, ImageBuild, ImageBuildPackage } from '../../admin-api';

export interface AppImageUpdateDraft {
  inheritedPackageIds: Readonly<Record<string, string>>;
  replacementPackageIds: Readonly<Record<string, string | null>>;
}

export interface ResolvedAppImageUpdateDraft {
  effectivePackageIds: Readonly<Record<string, string>>;
  packageIds: string[] | null;
  changedSlots: string[];
  missingRequiredSlots: string[];
  canBuild: boolean;
}

export function currentAppRevision(revisions: readonly AppVersion[]): AppVersion | null {
  return revisions.find((revision) => revision.status === 'active')
    ?? revisions.find((revision) => revision.status === 'legacy')
    ?? null;
}

export function inheritedPackageIdsForRevision(
  revision: AppVersion | null,
): Record<string, string> {
  if (!revision) return {};
  return Object.fromEntries(packagesForAppVersion(revision).flatMap((pkg) => (
    pkg.packageId ? [[pkg.key, pkg.packageId]] : []
  )));
}

export function createAppImageUpdateDraft(
  inheritedPackageIds: Readonly<Record<string, string>>,
): AppImageUpdateDraft {
  const normalizedPackageIds: Record<string, string> = {};
  for (const [key, packageId] of Object.entries(inheritedPackageIds)) {
    const normalizedId = packageId.trim();
    if (normalizedId) normalizedPackageIds[key] = normalizedId;
  }
  return { inheritedPackageIds: normalizedPackageIds, replacementPackageIds: {} };
}

export function replaceAppImageUpdatePackage(
  draft: AppImageUpdateDraft,
  key: string,
  packageId: string | null,
): AppImageUpdateDraft {
  if (packageId === null) return { ...draft, replacementPackageIds: { ...draft.replacementPackageIds, [key]: null } };
  const normalizedId = packageId.trim();
  if (!normalizedId || normalizedId === draft.inheritedPackageIds[key]) {
    return resetAppImageUpdateSlot(draft, key);
  }
  return {
    ...draft,
    replacementPackageIds: { ...draft.replacementPackageIds, [key]: normalizedId },
  };
}

export function resetAppImageUpdateSlot(
  draft: AppImageUpdateDraft,
  key: string,
): AppImageUpdateDraft {
  const replacementPackageIds = { ...draft.replacementPackageIds };
  delete replacementPackageIds[key];
  return { ...draft, replacementPackageIds };
}

export function resolveAppImageUpdateDraft(
  strategy: BuildStrategy,
  draft: AppImageUpdateDraft,
): ResolvedAppImageUpdateDraft {
  const effectivePackageIds: Record<string, string> = {};
  const packageIds: string[] = [];
  const changedSlots: string[] = [];
  const missingRequiredSlots: string[] = [];

  for (const requirement of strategy.packageRequirements) {
    const inheritedId = draft.inheritedPackageIds[requirement.key];
    const replacementId = draft.replacementPackageIds[requirement.key];
    const effectiveId = replacementId === null ? undefined : replacementId || inheritedId;
    if (effectiveId) {
      effectivePackageIds[requirement.key] = effectiveId;
      packageIds.push(effectiveId);
    } else if (requirement.required) {
      missingRequiredSlots.push(requirement.key);
    }
    if ((replacementId === null && inheritedId) || (replacementId && replacementId !== inheritedId)) changedSlots.push(requirement.key);
  }

  const canBuild = missingRequiredSlots.length === 0 && changedSlots.length > 0;

  return {
    effectivePackageIds,
    packageIds: canBuild ? packageIds : null,
    changedSlots,
    missingRequiredSlots,
    canBuild,
  };
}

/** 页面只展示服务端的通用包快照，不猜测历史产品字段。 */
export function packagesForAppVersion(version: AppVersion): ImageBuildPackage[] {
  return [...(version.packages ?? [])].sort(comparePackageKeys);
}

/** Returns one deterministic package-id selection only when every required slot is present. */
export function selectedPackageIds(
  strategy: BuildStrategy,
  selection: Readonly<Record<string, string>>,
): string[] | null {
  const ids: string[] = [];
  for (const requirement of strategy.packageRequirements) {
    const id = selection[requirement.key]?.trim() ?? '';
    if (!id) {
      if (requirement.required) return null;
      continue;
    }
    ids.push(id);
  }
  return ids;
}

export function versionSupportsStrategy(version: AppVersion, strategy: BuildStrategy): boolean {
  const packages = new Set(packagesForAppVersion(version).map((entry) => entry.key));
  return strategy.packageRequirements.every((requirement) => !requirement.required || packages.has(requirement.key));
}

export function buildMatchesVersion(build: ImageBuild, version: AppVersion): boolean {
  if (build.sourceAppVersionId && build.sourceAppVersionId !== version.id) return false;
  const versionPackages = packagesForAppVersion(version);
  const versionByKey = new Map(versionPackages.map((entry) => [entry.key, entry.artifact]));
  const buildByKey = new Map(build.packages.map((entry) => [entry.key, entry.artifact]));
  if (versionByKey.size !== versionPackages.length || buildByKey.size !== build.packages.length) return false;
  for (const requirement of build.strategySnapshot.packageRequirements) {
    const versionArtifact = versionByKey.get(requirement.key);
    const buildArtifact = buildByKey.get(requirement.key);
    if (requirement.required && (!versionArtifact || !buildArtifact)) return false;
    if (Boolean(versionArtifact) !== Boolean(buildArtifact)) return false;
    if (versionArtifact && buildArtifact
      && (versionArtifact.sha256 !== buildArtifact.sha256 || versionArtifact.size !== buildArtifact.size)) return false;
  }
  return true;
}

function comparePackageKeys(left: ImageBuildPackage, right: ImageBuildPackage): number {
  return left.key.localeCompare(right.key);
}
