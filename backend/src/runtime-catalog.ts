import type { ContainerCatalogSnapshot } from "./runtime.js";
import type { BuildStore, CatalogStore } from "./stores-contracts.js";

/** Docker labels are observations, not authority to create catalog records. */
export async function isRuntimeCatalogSnapshotValid(
  snapshot: ContainerCatalogSnapshot,
  catalog: Pick<CatalogStore, "getAppVersion">,
  builds: Pick<BuildStore, "getArtifact">,
): Promise<boolean> {
  const [version, artifact] = await Promise.all([
    snapshot.appVersionId ? catalog.getAppVersion(snapshot.appVersionId) : null,
    snapshot.imageArtifactId ? builds.getArtifact(snapshot.imageArtifactId) : null,
  ]);
  if (snapshot.appVersionId && (!version || version.appId !== snapshot.appId)) return false;
  if (snapshot.imageArtifactId && !artifact) return false;
  if (version && (version.imageArtifactId ?? null) !== snapshot.imageArtifactId) return false;
  if (artifact) {
    if (![artifact.imageId, artifact.imageReference].includes(snapshot.imageReference)) return false;
    if (version?.imageReference && ![artifact.imageId, artifact.imageReference].includes(version.imageReference)) return false;
  } else if (version?.imageReference && version.imageReference !== snapshot.imageReference) {
    return false;
  }
  return true;
}
