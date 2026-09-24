import { boundaryPolicy, forbiddenMarkerPattern } from './boundary-policy.mjs';
/**
 * OpenApp 兼容边界的单一清单。
 *
 * 源码扫描器使用 sourcePatterns 识别只能由 legacy 入口触达的模块，产物
 * sanitizer 使用 artifactPolicy 裁剪相同边界。两者必须从这里读取，避免
 * 新增兼容模块时出现“源码已登记但镜像仍携带”或相反的不一致。
 */

export const COMPATIBILITY_SOURCE_PATTERNS = Object.freeze([
  /(?:^|\/)backend\/src\/legacy\//u,
  /(?:^|\/)server-compat\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)portal-context\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)portal-context-compat\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)config\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)config-compat\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)stores\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)persistence\/active\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)auth\/index\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)auth\/compat\//u,
  /(?:^|\/)(?:instance-policy|strategy-definitions|build-strategies|app-catalog|app-image-updates)-compat\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)db\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)migrate\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)runtime-compat\.(?:ts|tsx|mjs|js)$/u,
  /(?:^|\/)frontend\/src\/features\/(?:auth|admin|entry)\/compat\//u,
]);

export const EXPLICIT_COMPATIBILITY_EDGE_KEYS = Object.freeze([
  "backend/src/server.ts -> backend/src/server-compat.ts",
  "frontend/src/features/admin/AppsPanel.tsx -> frontend/src/features/auth/compat/load.ts",
  "frontend/src/features/admin/OperationsPanel.tsx -> frontend/src/features/auth/compat/load.ts",
  "frontend/src/features/entry/user-entry-flow.ts -> frontend/src/features/auth/compat/load.ts",
  "frontend/src/features/auth/LoginPage.tsx -> frontend/src/features/auth/compat/load.ts",
  "frontend/src/features/auth/WorkspaceLoginPage.tsx -> frontend/src/features/auth/compat/load.ts",
]);

export const COMPATIBILITY_ARTIFACT_POLICY = Object.freeze({
  backendLegacyPaths: Object.freeze([
    ...(boundaryPolicy.backendPaths ?? []),
    "legacy",
    "server.js",
    "server-compat.js",
    "portal-context.js",
    "portal-context-compat.js",
    "config.js",
    "config-compat.js",
    "stores.js",
    "db.js",
    "migrate.js",
    "runtime-compat.js",
    "instance-policy-compat.js",
    "strategy-definitions-compat.js",
    "build-strategies-compat.js",
    "app-catalog-compat.js",
    "app-image-updates-compat.js",
    "release-manager.js",
    "testing",
    "persistence/active.js",
    "auth/index.js",
    "auth/compat",
  ]),
  runtimeLegacyPaths: Object.freeze(["runtime-compat.js", ...(boundaryPolicy.runtimePaths ?? [])]),
  frontendLegacyAssets: Object.freeze(boundaryPolicy.frontendAssets ?? []),
  frontendLegacyChunkPrefixes: Object.freeze([
    ...(boundaryPolicy.frontendChunkPrefixes ?? []),
    "provider-selection-",
    "legacy-entry-manifest-",
    "load-",
    "app-catalog-",
    "config-",
  ]),
});


export function isCompatibilitySourcePath(path) {
  const normalized = String(path).split("\\").join("/");
  return COMPATIBILITY_SOURCE_PATTERNS.some((pattern) => pattern.test(normalized));
}

export const GENERIC_FORBIDDEN_MARKER_PATTERN = forbiddenMarkerPattern;
export const GENERIC_FORBIDDEN_COUPLING_PATTERN = new RegExp(forbiddenMarkerPattern.source, "giu");
