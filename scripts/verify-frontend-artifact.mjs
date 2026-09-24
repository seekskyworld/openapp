#!/usr/bin/env node

/**
 * 校验 Frontend 发布目录的边界。
 *
 * generic 产物必须是可独立加载的产品无关 Portal：不能携带兼容 chunk、
 * source map 或 外部策略声明的禁止标记，也不能留下指向已裁剪文件的 import。
 * legacy 产物只执行完整性检查，兼容代码由显式 legacy bundle 承担。
 */
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  COMPATIBILITY_ARTIFACT_POLICY,
  GENERIC_FORBIDDEN_MARKER_PATTERN,
} from "./compatibility-manifest.mjs";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TEXT_EXTENSIONS = new Set([".css", ".html", ".js", ".mjs", ".cjs"]);

export async function verifyFrontendArtifact(rootInput, mode = "generic") {
  if (mode !== "generic" && mode !== "legacy") throw new Error("frontend artifact mode must be generic or legacy");
  const root = resolve(rootInput);
  const files = await walk(root);
  const byRelativePath = new Map(files.map((file) => [file.path, file]));
  const index = byRelativePath.get("index.html");
  if (!index) throw new Error("frontend artifact is missing index.html");
  const indexSource = await readFile(index.absolute, "utf8");
  const references = htmlReferences(indexSource);
  const missingReferences = references.filter((reference) => !resolveArtifactReference(reference, "index.html", byRelativePath));
  if (missingReferences.length > 0) {
    throw new Error(`frontend artifact has missing HTML references: ${missingReferences.join(", ")}`);
  }

  const violations = [];
  for (const file of files) {
    const extension = extname(file.path);
    if (mode === "generic" && file.path.endsWith(".map")) {
      violations.push(`source map ${file.path}`);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const source = await readFile(file.absolute, "utf8");
    const scanSource = extension === ".js" || extension === ".mjs" || extension === ".cjs"
      ? stripJavaScriptComments(source)
      : source;
    if (mode === "generic" && GENERIC_FORBIDDEN_MARKER_PATTERN.test(scanSource)) {
      violations.push(`product marker ${file.path}`);
    }
    if (mode === "generic") {
      if (isLegacyChunkPath(file.path)) violations.push(`compatibility chunk ${file.path}`);
      for (const target of staticImports(source)) {
        if (isLegacyChunkReference(target)) violations.push(`static compatibility import ${file.path} -> ${target}`);
        if (isLocalReference(target) && !resolveArtifactReference(target, file.path, byRelativePath)) {
          violations.push(`missing static import ${file.path} -> ${target}`);
        }
      }
      for (const target of dynamicImports(source)) {
        if (isLegacyChunkReference(target)) violations.push(`dynamic compatibility import ${file.path} -> ${target}`);
        if (isLocalReference(target) && !resolveArtifactReference(target, file.path, byRelativePath)) {
          violations.push(`missing dynamic import ${file.path} -> ${target}`);
        }
      }
    }
  }
  if (mode === "generic" && violations.length > 0) {
    throw new Error(`generic frontend artifact is not isolated: ${violations.join(", ")}`);
  }
  return {
    mode,
    files: files.length,
    htmlReferences: references,
    compatibilityChunks: files.filter((file) => isLegacyChunkPath(file.path)).map((file) => file.path),
  };
}

async function walk(root, directory = "") {
  const absoluteDirectory = join(root, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const childPath = directory ? `${directory}/${entry.name}` : entry.name;
    const absolute = join(root, childPath);
    if (entry.isSymbolicLink()) throw new Error(`frontend artifact rejects symlink: ${childPath}`);
    if (entry.isDirectory()) result.push(...await walk(root, childPath));
    else if (entry.isFile()) result.push({ path: childPath.split(sep).join("/"), absolute });
    else throw new Error(`frontend artifact rejects special file: ${childPath}`);
  }
  return result;
}

function htmlReferences(source) {
  const result = [];
  const pattern = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+)["']/giu;
  for (const match of source.matchAll(pattern)) {
    if (match[1]) result.push(match[1]);
  }
  return result;
}

function staticImports(source) {
  const result = [];
  const pattern = /\bimport\s+(?!\()(?:(?:[^'";\n]+?)\s+from\s*)?["']([^"']+)["']/gu;
  for (const match of source.matchAll(pattern)) if (match[1]) result.push(match[1]);
  return result;
}

function dynamicImports(source) {
  const result = [];
  const pattern = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  for (const match of source.matchAll(pattern)) if (match[1]) result.push(match[1]);
  return result;
}

function isLocalReference(value) {
  return value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
}

function resolveArtifactReference(reference, fromPath, files) {
  const clean = reference.split(/[?#]/u, 1)[0];
  if (!isLocalReference(clean)) return true;
  const relativeTarget = clean.startsWith("/")
    ? clean.slice(1)
    : resolve(dirname(`/${fromPath}`), clean).replace(/^\//u, "");
  const candidates = [relativeTarget, `${relativeTarget}.js`, `${relativeTarget}.css`];
  return candidates.some((candidate) => files.has(candidate));
}

function isLegacyChunkPath(path) {
  return COMPATIBILITY_ARTIFACT_POLICY.frontendLegacyChunkPrefixes.some((prefix) => (
    path.startsWith(`assets/${prefix}`)
  )) || COMPATIBILITY_ARTIFACT_POLICY.frontendLegacyAssets.some((asset) => path === asset || path === `assets/${asset}`);
}

function isLegacyChunkReference(reference) {
  const clean = reference.split(/[?#]/u, 1)[0];
  return isLegacyChunkPath(clean.startsWith("/") ? clean.slice(1) : clean)
    || COMPATIBILITY_ARTIFACT_POLICY.frontendLegacyChunkPrefixes.some((prefix) => clean.includes(`/${prefix}`));
}

function stripJavaScriptComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/[^\r\n]*/gu, "$1 ");
}

function parseArguments(argv) {
  const rootIndex = argv.indexOf("--root");
  const modeIndex = argv.indexOf("--mode");
  if (rootIndex < 0 || !argv[rootIndex + 1] || modeIndex < 0 || !argv[modeIndex + 1]) {
    throw new Error("usage: verify-frontend-artifact.mjs --root <directory> --mode <generic|legacy>");
  }
  return { root: argv[rootIndex + 1], mode: argv[modeIndex + 1] };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = await verifyFrontendArtifact(options.root, options.mode);
    process.stdout.write(`frontend ${result.mode} artifact verified (${result.files} files)\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
