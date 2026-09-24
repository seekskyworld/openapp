/** 只为教程的新部署生成本地配置；拒绝覆盖已有配置或数据目录。 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";

const [releaseArg, dataArg] = process.argv.slice(2);
if (!releaseArg || !dataArg) throw Error("usage: configure.mjs <new-release> <new-data-directory>");
const release = resolve(releaseArg);
const data = resolve(dataArg);
if (dirname(data) !== dirname(release)) throw Error("tutorial release and data must be sibling directories");
const envPath = join(release, "core/.env");
for (const target of [envPath, data]) {
  try {
    await access(target);
    throw Error(`already exists; use a fresh tutorial directory: ${target}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
const docker = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const platform = docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);
if (!["linux/amd64", "linux/arm64"].includes(platform))
  throw Error("tutorial requires a Linux amd64/arm64 Docker engine");
const manifest = JSON.parse(await readFile(join(release, "release-manifest.json"), "utf8"));
const fingerprint = manifest.sourceFingerprint.slice(0, 12);
const backendImage = `openapp-portal-backend:release-${fingerprint}`;
const project = `openapp-tutorial-${randomBytes(6).toString("hex")}`;
// UUID 占 36 字符；前缀必须留出 DNS 单标签 63 字符内的空间。
const resourcePrefix = `oat-${project.slice(-12)}-`;
const listener = createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
const origin = `http://127.0.0.1:${port}`;
const socketGid = docker([
  "run",
  "--rm",
  "--user",
  "0",
  "--entrypoint",
  "stat",
  "-v",
  "/var/run/docker.sock:/socket:ro",
  backendImage,
  "-c",
  "%g",
  "/socket",
]);
if (!/^\d+$/.test(socketGid)) throw Error("cannot determine Docker socket group");
let settings = await readFile(join(release, "core/.env.example"), "utf8");
if (!settings.includes("OPENAPP_APP_ID=notes-demo") || !settings.includes("OPENAPP_CONTROL_PLANE_ONLY=false"))
  throw Error("expected the composed Notes tutorial bundle");
const values = {
  COMPOSE_PROJECT_NAME: project,
  OPENAPP_DATA_ROOT: data,
  POSTGRES_PASSWORD: randomBytes(32).toString("hex"),
  OPENAPP_ADMIN_CLI_TOKEN: randomBytes(32).toString("hex"),
  PORTAL_PORT: String(port),
  PORTAL_BACKEND_PORT: "0",
  PUBLIC_ORIGIN: origin,
  PORTAL_PUBLIC_BASE_URL: origin,
  OPENAPP_RUNTIME_ALLOWED_ORIGINS: origin,
  OPENAPP_BRIDGE_ALLOWED_ORIGINS: origin,
  BACKEND_IMAGE: backendImage,
  FRONTEND_IMAGE: `openapp-frontend:release-${fingerprint}`,
  TARGET_PLATFORM: platform,
  DOCKER_GID: socketGid,
  OPENAPP_RUNTIME_IMAGE: "openapp-notes-demo:1.0.0",
  OPENAPP_NETWORK_NAME_PREFIX: `${resourcePrefix}n-`,
  OPENAPP_CONTAINER_NAME_PREFIX: `${resourcePrefix}u-`,
  OPENAPP_VOLUME_NAME_PREFIX: `${resourcePrefix}d-`,
  OPENAPP_CONTAINER_MEMORY: "256m",
  OPENAPP_CONTAINER_CPUS: "0.5",
};
for (const [key, value] of Object.entries(values)) {
  const pattern = new RegExp(`^${key}=.*$`, "m");
  settings = pattern.test(settings)
    ? settings.replace(pattern, `${key}=${value}`)
    : `${settings}\n${key}=${value}\n`;
}
await mkdir(data);
for (const directory of ["postgres/data", "postgres/init", "frontend/nginx/logs", "notes-demo"])
  await mkdir(join(data, directory), { recursive: true });
docker([
  "run",
  "--rm",
  "--user",
  "0",
  "--entrypoint",
  "chown",
  "--mount",
  `type=bind,src=${join(data, "notes-demo")},dst=/tutorial-releases`,
  backendImage,
  "10001:10001",
  "/tutorial-releases",
]);
await writeFile(envPath, settings, { mode: 0o600, flag: "wx" });
await writeFile(
  join(dirname(release), "tutorial-state.json"),
  JSON.stringify({ project, resourcePrefix, origin, data, platform }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(
  `Tutorial configured: ${origin}\nControl: ${origin}/control\nCompose project: ${project}\nData: ${data}`,
);
