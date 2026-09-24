const SEMVER_NUMERIC = "(?:0|[1-9][0-9]*)";
const SEMVER_PRERELEASE_ID = "(?:0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)";
export const APP_VERSION_PATTERN = new RegExp(
  `^${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}\\.${SEMVER_NUMERIC}(?:-${SEMVER_PRERELEASE_ID}(?:\\.${SEMVER_PRERELEASE_ID})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  "u",
);
export const BUILD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DOCKER_TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** Encodes SemVer build metadata without colliding with another valid App version. */
export function appVersionToDockerTag(value: unknown): string | null {
  if (typeof value !== "string" || !APP_VERSION_PATTERN.test(value)) return null;
  const tag = value.replace("+", "_");
  return DOCKER_TAG_PATTERN.test(tag) ? tag : null;
}

export function appVersionIsValid(value: unknown): value is string {
  return appVersionToDockerTag(value) !== null;
}

export function buildIdIsValid(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_PATTERN.test(value);
}
