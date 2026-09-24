#!/usr/bin/env node

/**
 * 校验 generic TypeScript 输出只包含生产闭包。这个检查和 sanitizer 的职责
 * 不同：它在编译后立即失败，防止把“先全量编译再裁剪”误当成生产构建成功。
 */
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const kindIndex = args.indexOf("--kind");
if (rootIndex < 0 || !args[rootIndex + 1] || kindIndex < 0 || !args[kindIndex + 1]) {
  throw new Error("usage: assert-generic-dist.mjs --root <directory> --kind <backend|runtime>");
}
const outputRoot = resolve(args[rootIndex + 1]);
const kind = args[kindIndex + 1];
if (kind !== "backend" && kind !== "runtime") throw new Error("generic output kind is invalid");

const forbidden = kind === "backend"
  ? [
    "server.js", "server-compat.js", "portal-context.js", "portal-context-compat.js",
    "config.js", "config-compat.js", "stores.js", "db.js", "migrate.js",
    "runtime-compat.js",
    "legacy", "auth/index.js",
    "auth/compat",
    "persistence/active.js",
  ]
  : ["runtime-compat.js", "testing"];

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function walk(directory, relative = "") {
  if (!(await exists(directory))) return [];
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const child = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(child, childRelative));
    else if (entry.isFile()) result.push({ path: childRelative, absolute: child });
    else throw new Error(`generic output contains a special file: ${childRelative}`);
  }
  return result;
}

const files = await walk(outputRoot);
const violations = [];
for (const relativePath of forbidden) {
  if (files.some(({ path }) => path === relativePath || path.startsWith(`${relativePath}/`))) {
    violations.push(`forbidden path ${relativePath}`);
  }
}
for (const { path } of files) {
  if (/\.test\.(?:cjs|js|mjs)$/u.test(path) || path.endsWith(".map")) {
    violations.push(`test or source map ${path}`);
    continue;
  }
}
if (violations.length > 0) throw new Error(`generic ${kind} output is not isolated: ${violations.join(", ")}`);
process.stdout.write(`generic ${kind} output verified (${files.length} files)\n`);
