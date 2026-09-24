#!/usr/bin/env node

/**
 * 检查三仓库的单向依赖、发布边界和通用生产导入图。
 *
 * 通用启动入口可以保留一个显式的 compatibility edge，但不能把兼容模块
 * 作为普通依赖继续遍历。这里优先使用 TypeScript AST（开发环境已有该依赖），
 * 没有 AST 解析器时再退回受限扫描器，保证导出后的门禁脚本仍可自包含运行。
 */
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { boundaryPolicy } from './boundary-policy.mjs';
import {
  COMPATIBILITY_SOURCE_PATTERNS,
  EXPLICIT_COMPATIBILITY_EDGE_KEYS,
  GENERIC_FORBIDDEN_COUPLING_PATTERN,
  isCompatibilitySourcePath,
} from "./compatibility-manifest.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const teamRoot = resolve(root, "..");
const adapterRoot = process.env.OPENAPP_ISOLATION_ADAPTER_ROOT ? resolve(process.env.OPENAPP_ISOLATION_ADAPTER_ROOT) : undefined;
const appRoot = process.env.OPENAPP_ISOLATION_APP_ROOT ? resolve(process.env.OPENAPP_ISOLATION_APP_ROOT) : undefined;
const strict = process.argv.includes("--strict") || process.env.OPENAPP_ISOLATION_STRICT === "1";

const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".js", ".cjs"]);
const ignoredNames = new Set(["node_modules", "dist", "build", ".git", ".cache"]);
const legacyModulePatterns = COMPATIBILITY_SOURCE_PATTERNS;
const explicitCompatibilityEdgeKeys = new Set(EXPLICIT_COMPATIBILITY_EDGE_KEYS);

// 产品的旧部署输入由 Adapter 发布面独占；Core 只保留通用模板和
// compatibility 代码。这里列出物理路径作为仓库级门禁，防止旧文件被重新
// 添加后仅靠导出阶段的裁剪掩盖所有权倒流。
export const CORE_LEGACY_DEPLOYMENT_INPUTS = Object.freeze([
  ...(boundaryPolicy.deploymentPaths ?? []),
  "backend/deployment/scripts/verify-runtime.sh",
  "backend/deployment/scripts/state-lock-recovery.test.mjs",
]);

let typeScript;
try {
  const loaded = await import("typescript");
  typeScript = loaded.default ?? loaded;
} catch {
  typeScript = undefined;
}

async function filesUnder(directory) {
  const result = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (sourceExtensions.has(extname(path))) result.push(path);
    }
  }
  await walk(directory);
  return result;
}

async function readSources(directory) {
  const entries = [];
  for (const path of await filesUnder(directory)) {
    entries.push({ path, source: await readFile(path, "utf8") });
  }
  return entries;
}

async function packageManifestsUnder(directory) {
  const result = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (ignoredNames.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === "package.json") result.push(path);
    }
  }
  await walk(directory);
  return result;
}

function isNonProductionSource(path) {
  const normalized = path.split(sep).join("/");
  return /\.test\.(?:ts|tsx|mjs|js|cjs)$/u.test(normalized)
    || normalized.includes("/testing/")
    || normalized.includes("/fixtures/");
}

function fail(message) {
  throw new Error(`architecture isolation check failed: ${message}`);
}

const repositoryNames = new Set([
  ...[root, adapterRoot, appRoot].filter(Boolean).map(path => path.split(sep).at(-1)),
  ...(boundaryPolicy.repositoryNames ?? []),
]);
const externalRepositorySegment = {
  test: value => value.split(/[\\/]/u).some(segment => repositoryNames.has(segment)),
};
const importReference = /\b(?:from|import|require)\s*(?:\(\s*)?["'`]([^"'`\r\n]+)["'`]/giu;
const pathBuilderCall = /\b(?:join|resolve|relative|normalize)\s*\(([^)]*)\)/giu;
const quotedLiteral = /"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|`(?:\\.|[^`\\\r\n])*`/gu;
const packageDependencyFields = new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
]);
const localDependencyScheme = /^(?:file|link|workspace):(.+)$/iu;
// 通用生产图不应出现具体产品的运行时名称；兼容岛被图遍历排除，因此其
// 中的 外部协议字面量不会被误报。边界写法同时覆盖字符串、标识符
// 和环境变量，避免只检查 import 关系而漏掉隐式产品耦合。
const genericProductCouplingPattern = GENERIC_FORBIDDEN_COUPLING_PATTERN;

function literalValue(value) {
  return value.slice(1, -1);
}

function isLocalPath(value) {
  return value.startsWith(".")
    || value.startsWith("/")
    || value.startsWith("\\")
    || /^file:/iu.test(value)
    || /^[A-Za-z]:[\\/]/u.test(value);
}

/**
 * 只把实际的本地仓库路径视为跨仓库依赖；裸仓库名、正则和文案不是依赖。
 * 这样隔离门禁可以在外部仓库自测自包含性时引用自己的包名，而不会误报。
 */
export function isExternalRepositoryReference(source, ownRepositoryName) {
  for (const match of source.matchAll(importReference)) {
    const reference = match[1];
    if (externalRepositorySegment.test(reference) && (isLocalPath(reference) || /[\\/]/u.test(reference))) {
      return true;
    }
  }

  for (const match of source.matchAll(pathBuilderCall)) {
    const argumentsSource = match[1];
    for (const literal of argumentsSource.matchAll(quotedLiteral)) {
      const value = literalValue(literal[0]);
      // 导出器可以创建与自身同名的产物目录；绝对路径、上级路径和其他仓库仍受检查。
      if (value === ownRepositoryName) continue;
      if (externalRepositorySegment.test(value)) return true;
    }
  }

  for (const match of source.matchAll(quotedLiteral)) {
    const value = literalValue(match[0]);
    if (isLocalPath(value) && externalRepositorySegment.test(value)) return true;
  }
  return false;
}

function isCrossRepositoryDependency(value) {
  const target = value.match(localDependencyScheme)?.[1]?.trim() ?? "";
  if (!target || target === "*" || target === "^" || target === "~") return false;
  return externalRepositorySegment.test(target);
}

/**
 * 检查外部仓库 manifest 的依赖字段。registry 版本和 workspace:* 等正常
 * 工作区语法不构成跨仓库边；只有明确指向本地 Core/Adapter 目录的依赖才拒绝。
 */
export function findPackageManifestBoundaryViolations(source, path = "package.json") {
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return [];
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const violations = [];
  function visit(value, location) {
    if (typeof value === "string") {
      if (isCrossRepositoryDependency(value)) violations.push({ path, field: location, value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) visit(child, `${location}.${key}`);
  }
  for (const field of packageDependencyFields) {
    if (Object.hasOwn(manifest, field)) visit(manifest[field], field);
  }
  return violations;
}

export async function collectPackageManifestBoundaryViolations(directory) {
  const violations = [];
  for (const path of await packageManifestsUnder(directory)) {
    const source = await readFile(path, "utf8");
    violations.push(...findPackageManifestBoundaryViolations(source, path));
  }
  return violations;
}

function isRuntimeImportClause(importClause, includeTypeOnly = false) {
  if (includeTypeOnly) return true;
  if (!importClause || importClause.isTypeOnly) return false;
  if (importClause.name) return true;
  const bindings = importClause.namedBindings;
  if (!bindings) return true;
  if (typeScript?.isNamespaceImport?.(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function astImportReferences(source, path, { includeTypeOnly = false } = {}) {
  const scriptKind = extname(path).toLowerCase() === ".tsx"
    ? typeScript.ScriptKind.TSX
    : typeScript.ScriptKind.TS;
  const sourceFile = typeScript.createSourceFile(
    path,
    source,
    typeScript.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const references = [];
  function visit(node) {
    if (typeScript.isImportDeclaration(node)) {
      if (node.moduleSpecifier && typeScript.isStringLiteral(node.moduleSpecifier)
        && isRuntimeImportClause(node.importClause, includeTypeOnly)) {
        references.push({ specifier: node.moduleSpecifier.text, kind: "static" });
      }
    } else if (typeScript.isExportDeclaration(node)) {
      const runtimeExport = includeTypeOnly || (!node.isTypeOnly
        && (!node.exportClause
          || !node.exportClause.elements
          || node.exportClause.elements.some((element) => !element.isTypeOnly)));
      if (runtimeExport && node.moduleSpecifier && typeScript.isStringLiteral(node.moduleSpecifier)) {
        references.push({ specifier: node.moduleSpecifier.text, kind: "static" });
      }
    } else if (typeScript.isCallExpression(node)
      && node.arguments.length === 1
      && typeScript.isStringLiteral(node.arguments[0])) {
      const isDynamicImport = node.expression.kind === typeScript.SyntaxKind.ImportKeyword;
      const isRequire = typeScript.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        references.push({ specifier: node.arguments[0].text, kind: isDynamicImport ? "dynamic" : "require" });
      }
    } else if (typeScript.isImportEqualsDeclaration(node)
      && typeScript.isExternalModuleReference(node.moduleReference)
      && typeScript.isStringLiteral(node.moduleReference.expression)) {
      references.push({ specifier: node.moduleReference.expression.text, kind: "static" });
    }
    typeScript.forEachChild(node, visit);
  }
  visit(sourceFile);
  return references;
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\r\n]*/gu, "$1 ");
}

/**
 * 在去除注释后查找通用生产代码中的具体产品名称。
 * 返回行号和短片段，便于门禁失败时直接定位，而不把文档/注释当作依赖。
 */
export function findGenericProductCoupling(source, path = "source.ts") {
  const cleaned = stripComments(source);
  const details = [];
  for (const match of cleaned.matchAll(genericProductCouplingPattern)) {
    const index = match.index ?? 0;
    const lineStart = cleaned.lastIndexOf("\n", index - 1) + 1;
    const lineEnd = cleaned.indexOf("\n", index);
    const line = cleaned.slice(lineStart, lineEnd < 0 ? cleaned.length : lineEnd).trim();
    details.push({
      path,
      line: cleaned.slice(0, index).split("\n").length,
      match: match[0],
      lineText: line.slice(0, 240),
    });
  }
  return details;
}

function fallbackImportReferences(source, { includeTypeOnly = false } = {}) {
  const cleaned = stripComments(source);
  const references = [];
  const staticPattern = /\b(?:import|export)\s+(?!\()([\s\S]*?\sfrom\s*)?["']([^"'\r\n]+)["']/gu;
  for (const match of cleaned.matchAll(staticPattern)) {
    if (!includeTypeOnly && /^type\b/u.test(match[1]?.trim() ?? "")) continue;
    references.push({ specifier: match[2], kind: "static" });
  }
  const sideEffectPattern = /\bimport\s*["']([^"'\r\n]+)["']/gu;
  for (const match of cleaned.matchAll(sideEffectPattern)) references.push({ specifier: match[1], kind: "static" });
  const dynamicPattern = /\bimport\s*\(\s*["']([^"'\r\n]+)["']\s*\)/gu;
  for (const match of cleaned.matchAll(dynamicPattern)) references.push({ specifier: match[1], kind: "dynamic" });
  const requirePattern = /\brequire\s*\(\s*["']([^"'\r\n]+)["']\s*\)/gu;
  for (const match of cleaned.matchAll(requirePattern)) references.push({ specifier: match[1], kind: "require" });
  return references;
}

/** 提取运行时导入；type-only import 不会进入生产依赖图。 */
export function extractImportReferences(source, path = "source.ts", options = {}) {
  if (typeScript) return astImportReferences(source, path, options);
  return fallbackImportReferences(source, options);
}

/** 提取完整本地依赖边（含 type-only），用于检查合同层不能反向依赖兼容 facade。 */
export function extractAllImportReferences(source, path = "source.ts") {
  return extractImportReferences(source, path, { includeTypeOnly: true });
}

function normalizeRelativePath(path) {
  return relative(root, path).split(sep).join("/");
}

function isLegacyCompatibilityModule(path) {
  return isCompatibilitySourcePath(path);
}

export function isCompatibilityModule(path) {
  return isLegacyCompatibilityModule(resolve(path));
}

/**
 * 盘点所有生产源码中的产品协议字面量。可达图只覆盖启动入口，孤立的
 * 旧 facade 可能永远不会被图遍历，因此这里单独登记并要求它们落在
 * compatibility island；测试 fixture 不属于发布产物，排除在盘点之外。
 */
export function collectCompatibilityInventory(sourceEntries) {
  return sourceEntries
    .filter(({ path }) => !isNonProductionSource(path))
    .map(({ path, source }) => ({
      path: normalizeRelativePath(path),
      matches: findGenericProductCoupling(source, normalizeRelativePath(path)),
      registered: isLegacyCompatibilityModule(path),
    }))
    .filter((item) => item.matches.length > 0);
}

function isExplicitCompatibilityEdge(from, to, reference) {
  if (reference.kind !== "dynamic" || !isLegacyCompatibilityModule(to)) return false;
  const key = `${normalizeRelativePath(from)} -> ${normalizeRelativePath(to)}`;
  // 只有列出的入口可以按显式模式动态加载兼容岛；兼容岛内部的 import
  // 不会进入通用闭包，因为它们只有在该边真正执行时才可达。
  return explicitCompatibilityEdgeKeys.has(key);
}

async function resolveLocalModule(from, specifier) {
  if (!specifier.startsWith(".")) {
    if (specifier === "@openapp/container-runtime") return join(root, "backend/runtime/src/index.ts");
    if (specifier === "@openapp/container-runtime/compat") return join(root, "backend/runtime/src/runtime-compat.ts");
    if (specifier === "@openapp/contracts") return join(root, "packages/contracts/src/index.ts");
    return null;
  }
  const base = resolve(dirname(from), specifier);
  const extension = extname(base);
  const bases = sourceExtensions.has(extension)
    ? [base, base.slice(0, -extension.length)]
    : [base];
  for (const candidate of [
    ...bases,
    ...bases.flatMap((value) => [...sourceExtensions].map((suffix) => `${value}${suffix}`)),
    ...bases.flatMap((value) => [...sourceExtensions].map((suffix) => join(value, `index${suffix}`))),
  ]) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // 继续尝试 TypeScript 的 .js -> .ts 映射和目录 index。
    }
  }
  return null;
}

/**
 * 从生产入口递归收集真实本地 import graph。显式 compatibility edge 会被
 * 记录但不会加入 generic closure，避免“动态回退”伪装成通用依赖。
 */
export async function collectImportGraph(entryPaths) {
  const entries = entryPaths.map((entry) => resolve(entry));
  const nodes = new Set();
  const edges = [];
  const queue = [...entries];
  while (queue.length > 0) {
    const current = queue.shift();
    if (nodes.has(current)) continue;
    nodes.add(current);
    let source;
    try {
      source = await readFile(current, "utf8");
    } catch (error) {
      edges.push({ from: current, to: null, kind: "missing-entry", error: String(error) });
      continue;
    }
    for (const reference of extractImportReferences(source, current)) {
      const target = await resolveLocalModule(current, reference.specifier);
      if (!target) continue;
      const compatibility = isExplicitCompatibilityEdge(current, target, reference);
      edges.push({
        from: current,
        to: target,
        specifier: reference.specifier,
        kind: reference.kind,
        compatibility,
      });
      if (!compatibility) queue.push(target);
    }
  }
  return { entries, nodes: [...nodes], edges };
}

/**
 * 检查生产入口的完整依赖图，包括 type-only 边。TypeScript 的类型引用虽
 * 不会进入打包结果，但会把通用模块绑到旧 facade，导致合同层无法独立发布。
 * 显式、审计过的动态兼容边仍只记录不遍历。
 */
export async function collectImportBoundaryViolations(entryPaths, label) {
  const entries = entryPaths.map((entry) => resolve(entry));
  const nodes = new Set();
  const queue = [...entries];
  const violations = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (nodes.has(current)) continue;
    nodes.add(current);
    let source;
    try {
      source = await readFile(current, "utf8");
    } catch {
      continue;
    }
    for (const reference of extractAllImportReferences(source, current)) {
      const target = await resolveLocalModule(current, reference.specifier);
      if (!target) continue;
      const compatibility = isExplicitCompatibilityEdge(current, target, reference);
      if (isLegacyCompatibilityModule(target)) {
        if (!compatibility) {
          violations.add(`${label} imports compatibility module ${normalizeRelativePath(current)} -> ${normalizeRelativePath(target)} (${reference.kind})`);
        }
        continue;
      }
      queue.push(target);
    }
  }
  return [...violations];
}

async function checkGitBoundary() {
  const { stdout } = await execFileAsync("git", ["-C", root, "ls-files", "deployment"]);
  if (stdout.trim()) fail(`generated deployment directory is tracked: ${stdout.trim().split("\n")[0]}`);
}

export async function findCoreLegacyDeploymentBoundaryViolations() {
  const violations = [];
  for (const relativePath of CORE_LEGACY_DEPLOYMENT_INPUTS) {
    try {
      const info = await lstat(join(root, relativePath));
      violations.push({
        path: relativePath,
        kind: info.isDirectory() ? "directory" : info.isFile() ? "file" : "special",
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return violations;
}

async function checkExternalRepositories() {
  const packageManifestViolations = [];
  for (const [label, directory] of [
    ["adapter", adapterRoot],
    ["app", appRoot],
  ]) {
    if (!directory) continue;
    if (!(await lstat(directory)).isDirectory()) fail(`${label} repository root must be a directory`);
    for (const { path, source } of await readSources(directory)) {
      if (isExternalRepositoryReference(source, directory.split(/[\\/]/u).at(-1))) {
        fail(`${label} imports or embeds another repository: ${relative(teamRoot, path)}`);
      }
    }
    for (const violation of await collectPackageManifestBoundaryViolations(directory)) {
      packageManifestViolations.push({
        repository: label,
        ...violation,
      });
      fail(`${label} package manifest contains a local dependency into another repository: ${relative(teamRoot, violation.path)} (${violation.field}=${violation.value})`);
    }
  }
  return packageManifestViolations;
}

function graphViolations(graph, label) {
  return graph.nodes
    .filter((path) => isLegacyCompatibilityModule(path))
    .map((path) => `${label} reaches compatibility module ${normalizeRelativePath(path)}`);
}

export async function collectDirectImportBoundaryViolations(entries, label) {
  const violations = [];
  for (const { path, source } of entries) {
    const normalized = normalizeRelativePath(path);
    if (/\.test\.(?:ts|tsx|mjs|js)$/u.test(normalized)
      || normalized.includes("/testing/")
      || isLegacyCompatibilityModule(path)) continue;
    // 这里必须包含 type-only import。它不会进入 JS bundle，却仍会让
    // 通用源码在编译时绑定到兼容 facade，破坏合同包的独立发布。
    for (const reference of extractAllImportReferences(source, path)) {
      const target = await resolveLocalModule(path, reference.specifier);
      if (target && isLegacyCompatibilityModule(target)
        && !isExplicitCompatibilityEdge(path, target, reference)) {
        violations.push(`${label} imports compatibility module ${normalized} -> ${normalizeRelativePath(target)}`);
      }
    }
  }
  return violations;
}

async function checkCoreProductionBoundary() {
  const entries = await readSources(join(root, "backend", "src"));
  const contractEntries = await readSources(join(root, "packages", "contracts", "src"));
  const graph = await collectImportGraph([
    // Docker/production 的唯一入口是 server-generic；server.ts 只是旧版
    // 兼容分流入口，不能因为仍被保留就把 legacy edge 算入通用生产图。
    join(root, "backend/src/server-generic.ts"),
    join(root, "backend/src/portal-context-generic.ts"),
  ]);
  const violations = [
    ...graphViolations(graph, "Core"),
    ...(await collectDirectImportBoundaryViolations(entries, "Core")),
    ...(await collectDirectImportBoundaryViolations(contractEntries, "Contracts")),
    ...(await collectImportBoundaryViolations([
      join(root, "backend/src/server-generic.ts"),
      join(root, "backend/src/portal-context-generic.ts"),
      join(root, "packages/contracts/src/index.ts"),
    ], "Core")),
  ];
  const productCoupling = (await Promise.all(graph.nodes.map(async (path) => (
    findGenericProductCoupling(await readFile(path, "utf8"), normalizeRelativePath(path))
  )))).flat();
  if (strict && productCoupling.length > 0) {
    fail(`generic Core production graph contains product coupling (${productCoupling.map((item) => `${item.path}:${item.line}:${item.match}`).join(", ")})`);
  }
  if (strict && violations.length > 0) fail(`generic Core production graph is not isolated (${violations.join(", ")})`);
  return { violations, graph, productCoupling };
}

async function checkRuntimeProductionBoundary() {
  const entries = await readSources(join(root, "backend/runtime/src"));
  const graph = await collectImportGraph([join(root, "backend/runtime/src/index.ts")]);
  const violations = [
    ...graphViolations(graph, "Runtime"),
    ...(await collectDirectImportBoundaryViolations(entries, "Runtime")),
    ...(await collectImportBoundaryViolations([join(root, "backend/runtime/src/index.ts")], "Runtime")),
  ];
  const productCoupling = (await Promise.all(graph.nodes.map(async (path) => (
    findGenericProductCoupling(await readFile(path, "utf8"), normalizeRelativePath(path))
  )))).flat();
  if (strict && productCoupling.length > 0) {
    fail(`generic Runtime production graph contains product coupling (${productCoupling.map((item) => `${item.path}:${item.line}:${item.match}`).join(", ")})`);
  }
  if (strict && violations.length > 0) fail(`generic Runtime production graph is not isolated (${violations.join(", ")})`);
  return { violations, graph, productCoupling };
}

async function checkFrontendProductionBoundary() {
  const entries = await readSources(join(root, "frontend", "src"));
  const graph = await collectImportGraph([join(root, "frontend/src/main.tsx")]);
  const violations = [
    ...graphViolations(graph, "Frontend"),
    ...(await collectDirectImportBoundaryViolations(entries, "Frontend")),
    ...(await collectImportBoundaryViolations([join(root, "frontend/src/main.tsx")], "Frontend")),
  ];
  const productCoupling = (await Promise.all(graph.nodes.map(async (path) => (
    findGenericProductCoupling(await readFile(path, "utf8"), normalizeRelativePath(path))
  )))).flat();
  if (strict && productCoupling.length > 0) {
    fail(`generic Frontend production graph contains product coupling (${productCoupling.map((item) => `${item.path}:${item.line}:${item.match}`).join(", ")})`);
  }
  if (strict && violations.length > 0) fail(`generic Frontend production graph is not isolated (${violations.join(", ")})`);
  return { violations, graph, productCoupling };
}

async function checkCompatibilityInventory() {
  const sources = [];
  for (const directory of [
    join(root, "backend", "src"),
    join(root, "backend", "runtime", "src"),
    join(root, "frontend", "src"),
    join(root, "packages", "contracts", "src"),
  ]) {
    sources.push(...await readSources(directory));
  }
  const inventory = collectCompatibilityInventory(sources);
  const violations = inventory
    .map((item) => `${item.path}:${item.matches.map((match) => match.match).join(",")}`);
  if (violations.length > 0) {
    fail(`product implementation remains in Core source (${violations.join("; ")})`);
  }
  return { inventory, violations };
}

export async function runIsolationCheck() {
  await checkGitBoundary();
  const deploymentBoundary = await findCoreLegacyDeploymentBoundaryViolations();
  if (strict && deploymentBoundary.length > 0) {
    fail(`Core owns forbidden deployment inputs (${deploymentBoundary.map(({ path }) => path).join(", ")})`);
  }
  const externalRepository = await checkExternalRepositories();
  const inventory = await checkCompatibilityInventory();
  const core = await checkCoreProductionBoundary();
  const runtime = await checkRuntimeProductionBoundary();
  const frontend = await checkFrontendProductionBoundary();
  const compatibilityEdges = [...core.graph.edges, ...runtime.graph.edges, ...frontend.graph.edges]
    .filter((edge) => edge.compatibility)
    .map((edge) => ({
      from: normalizeRelativePath(edge.from),
      to: normalizeRelativePath(edge.to),
      kind: edge.kind,
    }));
  const violations = [
    ...deploymentBoundary.map(({ path }) => `Core owns legacy deployment input ${path}`),
    ...inventory.violations,
    ...core.violations,
    ...runtime.violations,
    ...frontend.violations,
  ];
  const productCoupling = [
    ...core.productCoupling,
    ...runtime.productCoupling,
    ...frontend.productCoupling,
  ];
  const mode = strict ? "strict" : "transition";
  process.stdout.write(JSON.stringify({
    ok: true,
    mode,
    externalPolicyLoaded: Boolean(process.env.OPENAPP_BOUNDARY_POLICY),
    repositories: {
      core: relative(teamRoot, root),
      adapter: adapterRoot ? relative(teamRoot, adapterRoot) : null,
      app: appRoot ? relative(teamRoot, appRoot) : null,
    },
    packageManifestViolations: externalRepository,
    deploymentBoundary,
    genericProductionGraph: {
      coreNodes: core.graph.nodes.length,
      runtimeNodes: runtime.graph.nodes.length,
      frontendNodes: frontend.graph.nodes.length,
      compatibilityEdges,
      genericProductCoupling: productCoupling.length,
      genericProductCouplingDetails: productCoupling,
    },
    compatibilityInventory: inventory.inventory,
    compatibilityInventoryViolations: inventory.violations,
    compatibilityViolations: violations.length,
    violations,
  }, null, 2) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runIsolationCheck();
}
