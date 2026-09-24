#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, readdir, lstat, cp } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sourceProvenance } from "./release/source-provenance.mjs";
import { writeDependencyNotices } from "./release/dependency-notices.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [configArg, outputArg, ...flags] = process.argv.slice(2);
if (flags.some((flag) => flag !== "--official")) throw Error("unknown release option");
const official = flags.includes("--official");
if (!configArg || !outputArg)
  throw Error("usage: node scripts/export-openapp.mjs <plugins.json> <new-output>");
const configPath = resolve(configArg);
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.schemaVersion !== 1 || !Array.isArray(config.plugins)) throw Error("invalid plugin build catalog");
const coreOnly = config.plugins.length === 0;
const ids = new Set();
for (const entry of config.plugins) {
  if (
    typeof entry.id !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.id) ||
    ids.has(entry.id) ||
    typeof entry.source !== "string" ||
    typeof entry.version !== "string"
  )
    throw Error("invalid or duplicate plugin");
  ids.add(entry.id);
}
if (!coreOnly && !ids.has(config.defaultAppId)) throw Error("defaultAppId must select a plugin");
if (coreOnly && (config.defaultAppId || config.compatibilityMode !== false))
  throw Error("Core-only release cannot select an App or legacy mode");
if (typeof config.compatibilityMode !== "boolean") throw Error("compatibilityMode must be explicit");
const output = resolve(outputArg);
try {
  await lstat(output);
  throw Error("output already exists");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const coreSource = sourceProvenance(root, { official });
const pluginSources = config.plugins.map((entry) => ({
  id: entry.id,
  version: entry.version,
  ...sourceProvenance(resolve(dirname(configPath), entry.source), { official }),
}));
const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: "inherit" });
run("npm", ["--prefix", "packages/contracts", "run", "build"]);
run("npm", ["--prefix", "backend", "run", config.compatibilityMode ? "build" : "build:generic"]);
run("npm", ["--prefix", "frontend", "run", config.compatibilityMode ? "build" : "build:generic"]);
const plugins = [];
const authUiProviders = {};
let defaultAuthUiProvider;
for (const entry of config.plugins) {
  const source = resolve(dirname(configPath), entry.source);
  const packageMetadata = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const authUi = packageMetadata.openapp?.authUi;
  if (authUi) {
    if (
      authUi.apiVersion !== 1 ||
      typeof authUi.providerId !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(authUi.providerId) ||
      typeof authUi.module !== "string" ||
      !/^[A-Za-z0-9_-]+\.mjs$/.test(authUi.module) ||
      Object.hasOwn(authUiProviders, authUi.providerId)
    )
      throw Error("invalid or duplicate auth UI extension");
    await readFile(join(source, "assets", authUi.module));
    authUiProviders[authUi.providerId] = `/adapter-assets/${entry.id}/${authUi.module}`;
    if (entry.id === config.defaultAppId) defaultAuthUiProvider = authUi.providerId;
  }
  run("npm", ["run", "build"], source);
  run(process.execPath, [
    "scripts/validate-adapter-manifest.mjs",
    "--adapter-root",
    source,
    "--app-id",
    entry.id,
    "--adapter-id",
    entry.id,
  ]);
  run(process.execPath, [
    "scripts/validate-adapter-assets.mjs",
    "--adapter-root",
    source,
    "--adapter-id",
    entry.id,
  ]);
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (pkg.version !== entry.version) throw Error(`plugin version mismatch: ${entry.id}`);
  if (Object.keys(pkg.dependencies ?? {}).some((name) => name !== "@openapp/contracts")) {
    throw Error(`plugin ${entry.id} must bundle third-party runtime dependencies into dist before export`);
  }
  const environment = { ...(entry.environment ?? {}) };
  if (await exists(join(source, "runtime/Dockerfile"))) {
    run(process.execPath, [
      "scripts/validate-adapter-runtime.mjs",
      "--runtime-root",
      join(source, "runtime"),
      "--app-id",
      entry.id,
      "--require-app-id",
    ]);
    environment.OPENAPP_RUNTIME_DOCKERFILE = `/app/backend/adapters/${entry.id}/runtime/Dockerfile`;
  }
  plugins.push({ ...entry, source, environment });
}
const runtimeCatalog = {
  schemaVersion: 1,
  plugins: plugins.map((p) => ({
    id: p.id,
    version: p.version,
    module: `/app/backend/adapters/${p.id}/dist/index.js`,
    environment: p.environment,
  })),
};
const { parseAdapterCatalog } = await import(pathToFileURL(join(root, "backend/dist/adapter-catalog.js")));
if (!coreOnly) parseAdapterCatalog(runtimeCatalog);
// Exercise exactly the runtime loader, including registry conflict checks, before exporting.
const { loadConfiguredAppPlugins } = await import(
  pathToFileURL(join(root, "backend/dist/portal-context-core.js"))
);
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const temporary = await mkdtemp(join(tmpdir(), "openapp-catalog-"));
try {
  const path = join(temporary, "plugins.json");
  await writeFile(
    path,
    JSON.stringify({
      ...runtimeCatalog,
      plugins: runtimeCatalog.plugins.map((p, i) => ({
        ...p,
        module: join(plugins[i].source, "dist/index.js"),
      })),
    }),
  );
  if (!coreOnly)
    await loadConfiguredAppPlugins({
      artifacts: {},
      environment: {
        ...process.env,
        OPENAPP_APP_ID: config.defaultAppId,
        OPENAPP_ADAPTER_CATALOG: path,
        OPENAPP_ADAPTER_ALLOWED_ROOTS: plugins.map((p) => p.source).join(","),
      },
    });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
await mkdir(output);
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
async function copy(from, to) {
  const info = await lstat(from);
  if (info.isSymbolicLink()) throw Error(`symlink not allowed: ${from}`);
  if (info.isDirectory()) {
    await mkdir(to, { recursive: true });
    for (const name of await readdir(from)) {
      if (
        ["node_modules", ".DS_Store", ".env", "logs", "testing", "tests"].includes(name) ||
        /\.(test|spec)\./.test(name) ||
        name.endsWith(".map")
      )
        continue;
      await copy(join(from, name), join(to, name));
    }
  } else if (info.isFile()) {
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
  } else throw Error(`invalid release input: ${from}`);
}
for (const path of [
  "backend/dist",
  "backend/package.json",
  "backend/package-lock.json",
  "backend/runtime/dist",
  "backend/runtime/package.json",
  "backend/runtime/package-lock.json",
  "packages/contracts/dist",
  "packages/contracts/package.json",
]) {
  await copy(join(root, path), join(output, "core", path));
}
await copy(join(root, "frontend/dist"), join(output, "core/frontend/web"));
await writeFile(
  join(output, "core/frontend/web/auth-adapters.json"),
  JSON.stringify(
    { schemaVersion: 1, defaultProviderId: defaultAuthUiProvider, providers: authUiProviders },
    null,
    2,
  ) + "\n",
);
await copy(join(root, "backend/deployment/scripts"), join(output, "core/backend/deployment/scripts"));
for (const plugin of plugins) {
  const target = join(output, `openapp-${plugin.id}-adapter`);
  for (const path of ["dist", "package.json", "runtime", "deployment/build", "LICENSE", "NOTICE"])
    if (await exists(join(plugin.source, path))) await copy(join(plugin.source, path), join(target, path));
  if (await exists(join(plugin.source, "assets")))
    await copy(join(plugin.source, "assets"), join(output, "core/frontend/web/adapter-assets", plugin.id));
  for (const [alias, asset] of Object.entries(plugin.assetAliases ?? {})) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(alias) ||
      typeof asset !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(asset)
    )
      throw Error("invalid asset alias");
    const target = join(output, "core/frontend/web", alias);
    if (await exists(target)) throw Error(`asset alias collision: ${alias}`);
    await copy(join(plugin.source, "assets", asset), target);
  }
}
const template = join(root, "backend/deployment/bundle");
let dockerfile = await readFile(join(template, "backend.Dockerfile"), "utf8");
dockerfile = dockerfile
  .replace(/^COPY backend\//gm, "COPY core/backend/")
  .replaceAll(" backend/package-lock.json", " core/backend/package-lock.json")
  .replaceAll(" backend/runtime/package-lock.json", " core/backend/runtime/package-lock.json")
  .replace(/^COPY packages\//gm, "COPY core/packages/")
  .replace(
    "COPY adapters/ ./adapters/",
    plugins.map((p) => `COPY openapp-${p.id}-adapter/ ./adapters/${p.id}/`).join("\n") +
      "\nCOPY core/plugins.json ./plugins.json",
  );
if (config.compatibilityMode) {
  dockerfile = dockerfile
    .replace(/COPY scripts\/prune-generic-artifacts.mjs[^]*?(?=RUN chmod)/, "")
    .replace("dist/server-generic.js", "dist/server.js");
} else {
  for (const name of ["prune-generic-artifacts.mjs", "compatibility-manifest.mjs", "boundary-policy.mjs"]) {
    await copy(join(root, "scripts", name), join(output, "scripts", name));
  }
  // 先执行与镜像构建一致的裁剪再计算指纹，避免干净安装产生的类型声明使部署后校验失效。
  run(process.execPath, [
    join(output, "scripts/prune-generic-artifacts.mjs"),
    "--root",
    join(output, "core"),
  ]);
}
await writeFile(join(output, "core/backend/Dockerfile"), dockerfile);
await writeFile(join(output, "core/plugins.json"), JSON.stringify(runtimeCatalog, null, 2) + "\n");
for (const [src, dst] of [
  ["frontend.Dockerfile", "frontend/Dockerfile"],
  ["nginx.conf", "frontend/nginx/default.conf"],
  ["bootstrap-admin.sh", "bootstrap-admin.sh"],
  ["status.sh", "status.sh"],
  ["logs.sh", "logs.sh"],
  ["stop.sh", "stop.sh"],
  ["Caddyfile", "Caddyfile"],
])
  await copy(join(template, src), join(output, "core", dst));
let compose = await readFile(join(template, "docker-compose.yml"), "utf8");
// 固定容器名会使不同 Compose 项目的新安装互相冲突；旧部署可显式保留原名称。
compose = compose.replace(
  /container_name: openapp-([a-z-]+)/g,
  (_, service) =>
    `container_name: \${OPENAPP_${service.replaceAll("-", "_").toUpperCase()}_CONTAINER:-\${COMPOSE_PROJECT_NAME}-${service}}`,
);
compose = compose.replace(
  "${OPENAPP_PORTAL_CONTAINER:-openapp-portal-backend}",
  "${OPENAPP_PORTAL_BACKEND_CONTAINER:-${COMPOSE_PROJECT_NAME}-portal-backend}",
);
compose = compose
  .replace("  portal-backend:\n", "  portal-backend:\n    env_file: .env\n")
  .replace("context: .\n", "context: ..\n")
  .replace("dockerfile: backend/Dockerfile", "dockerfile: core/backend/Dockerfile")
  .replaceAll("./postgres/", "${OPENAPP_DATA_ROOT:?set existing absolute data root}/postgres/")
  .replace(
    "source: ./${OPENAPP_RELEASE_PATH:-openapp}",
    "source: ${OPENAPP_DATA_ROOT:?set existing absolute data root}/${OPENAPP_RELEASE_PATH:-openapp}",
  )
  .replace(
    "./frontend/nginx/logs:",
    "${OPENAPP_DATA_ROOT:?set existing absolute data root}/frontend/nginx/logs:",
  )
  .replace(
    "      NODE_ENV: production",
    `      OPENAPP_CONTROL_PLANE_ONLY: \"${coreOnly}\"\n      OPENAPP_ADAPTER_CATALOG: \"${coreOnly ? "" : "/app/backend/plugins.json"}\"\n      NODE_ENV: production`,
  );
if (coreOnly) {
  compose = compose
    .replace(/  docker-socket-proxy:\n[\s\S]*?(?=  portal-backend:)/, "")
    .replace(/      docker-socket-proxy:\n        condition: service_healthy\n/, "")
    .replace("      DOCKER_HOST: tcp://docker-socket-proxy:2375\n", "")
    .replace("networks: [control, docker-control, egress]", "networks: [control, egress]")
    .replace("  docker-control:\n    internal: true\n", "");
}
await writeFile(join(output, "core/docker-compose.yml"), compose);
for (const name of [".env.example", ".env.production.example"]) {
  let env = await readFile(join(template, name), "utf8");
  const values = {
    OPENAPP_APP_ID: config.defaultAppId ?? "",
    OPENAPP_ADAPTER_ID: config.defaultAppId ?? "",
    OPENAPP_RELEASE_PATH: config.defaultAppId ?? "openapp",
    OPENAPP_ADAPTER_MODULE: "",
    OPENAPP_ADAPTER_CATALOG: coreOnly ? "" : "/app/backend/plugins.json",
    OPENAPP_ADAPTER_ALLOWED_ROOTS: coreOnly ? "" : "/app/backend/adapters",
    OPENAPP_ADAPTER_REQUIRED: String(!coreOnly),
    OPENAPP_CONTROL_PLANE_ONLY: String(coreOnly),
    OPENAPP_COMPATIBILITY_MODE: String(config.compatibilityMode),
    COMPOSE_PROJECT_NAME: "",
    OPENAPP_DATA_ROOT: "",
  };
  for (const [key, value] of Object.entries(values)) {
    const re = new RegExp(`^${key}=.*$`, "m");
    env = re.test(env) ? env.replace(re, `${key}=${value}`) : env + `\n${key}=${value}\n`;
  }
  await writeFile(join(output, "core", name), env);
}
// No legacy overlay: compatibility is selected by backend environment, not by product files.
let helper = await readFile(join(root, "scripts/release/compose-files.sh"), "utf8");
helper = helper.replace(/case "\$\{OPENAPP_COMPATIBILITY_MODE[^]*?(?=openapp_compose\(\))/, "");
await writeFile(join(output, "core/compose-files.sh"), helper);
await copy(join(root, "scripts/release/build-openapp.sh"), join(output, "build-images.sh"));
await copy(join(root, "scripts/release/verify.mjs"), join(output, "verify.mjs"));
await copy(join(root, "docs/plugin-catalog-release.en.md"), join(output, "README.md"));
await copy(join(root, "docs/plugin-catalog-release.md"), join(output, "README.zh-CN.md"));
await copy(join(root, "docs/first-install.md"), join(output, "first-install.md"));
await copy(join(root, "docs/first-install.en.md"), join(output, "first-install.en.md"));
await copy(join(root, "THIRD_PARTY_NOTICES.md"), join(output, "THIRD_PARTY_NOTICES.md"));
await copy(join(root, "LICENSE"), join(output, "LICENSE"));
await copy(join(root, "LICENSE"), join(output, "core/frontend/web/LICENSE"));
await copy(join(root, "packages/contracts/LICENSE"), join(output, "core/packages/contracts/LICENSE"));
await writeDependencyNotices(root, output);
const sourceMetadata = {
  schemaVersion: 1,
  releaseMode: official ? "official" : "development",
  core: { version: JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, ...coreSource },
  contractsVersion: JSON.parse(await readFile(join(root, "packages/contracts/package.json"), "utf8")).version,
  plugins: pluginSources,
};
// 构建期间若源码被并发编辑，不能将旧来源摘要标记到新制品上。
for (const [directory, before] of [
  [root, coreSource],
  ...plugins.map((p, i) => [p.source, pluginSources[i]]),
]) {
  const after = sourceProvenance(directory, { official });
  if (
    after.sourceDigest !== before.sourceDigest ||
    after.revision !== before.revision ||
    after.dirty !== before.dirty
  ) {
    throw Error("component source changed while building; export again from a stable checkout");
  }
}
await writeFile(join(output, "source-provenance.json"), JSON.stringify(sourceMetadata, null, 2) + "\n");
await writeFile(join(output, ".dockerignore"), "**/node_modules\n**/.env\n**/.DS_Store\n**/*.map\n");
const files = {};
async function hashFiles(path = "") {
  for (const name of (await readdir(join(output, path))).sort()) {
    const relative = path ? `${path}/${name}` : name;
    if ((await lstat(join(output, relative))).isDirectory()) await hashFiles(relative);
    else
      files[relative] = createHash("sha256")
        .update(await readFile(join(output, relative)))
        .digest("hex");
  }
}
await hashFiles();
const fingerprint = createHash("sha256").update(JSON.stringify(files)).digest("hex");
await writeFile(
  join(output, "release-manifest.json"),
  JSON.stringify(
    {
      schemaVersion: 1,
      kind: "openapp-control-plane",
      sourceFingerprint: fingerprint,
      coreRevision: coreSource.revision,
      releaseMode: sourceMetadata.releaseMode,
      plugins: runtimeCatalog.plugins.map(({ id, version }) => ({ id, version })),
      files,
    },
    null,
    2,
  ) + "\n",
);
run(process.execPath, [join(output, "verify.mjs")]);
console.log(`OpenApp control-plane bundle exported: ${output}`);
