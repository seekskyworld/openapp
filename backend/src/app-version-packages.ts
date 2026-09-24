import type { AppVersion, BuildStrategy, ImageBuildPackage } from "./models.js";

/** 所有旧字段转换必须在 Adapter 声明的持久化迁移边界完成。 */
export function packagesForVersion(version: AppVersion): ImageBuildPackage[] {
  return structuredClone(version.packages ?? []).sort((a, b) => a.key.localeCompare(b.key));
}

/** Selects only the package slots declared by one frozen strategy. */
export function packagesForVersionStrategy(version: AppVersion, strategy: BuildStrategy): ImageBuildPackage[] {
  const keys = new Set(strategy.packageRequirements.map((requirement) => requirement.key));
  return packagesForVersion(version).filter((entry) => keys.has(entry.key));
}

/** Ensures API and persistence projections expose generic slots for old rows. */
export function withVersionPackageProjection(version: AppVersion): AppVersion {
  return { ...version, packages: packagesForVersion(version) };
}
