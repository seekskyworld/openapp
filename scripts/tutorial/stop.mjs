/** 只停止本次教程标记且名称、标签均匹配的资源；保留 Volume 与数据库供复查。 */
import { readFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
const release = resolve(process.argv[2] ?? "");
let state;
try {
  state = JSON.parse(await readFile(join(dirname(release), "tutorial-state.json"), "utf8"));
} catch (error) {
  if (error.code === "ENOENT") process.exit(0);
  throw error;
}
if (!/^openapp-tutorial-[a-f0-9]{12}$/.test(state.project)) throw Error("invalid tutorial identity");
if (state.resourcePrefix !== `oat-${state.project.slice(-12)}-`) throw Error("invalid resource prefix");
const env = await readFile(join(release, "core/.env"), "utf8");
if (!env.includes(`COMPOSE_PROJECT_NAME=${state.project}\n`)) throw Error("tutorial project mismatch");
const docker = (args) => execFileSync("docker", args, { encoding: "utf8" }).trim();
const ids = docker([
  "ps",
  "-q",
  "--filter",
  `name=^/${state.resourcePrefix}u-`,
  "--filter",
  "label=io.openapp.notes-demo.managed=true",
])
  .split(/\s+/)
  .filter(Boolean);
for (const id of ids) {
  const [container] = JSON.parse(docker(["inspect", id]));
  if (
    !container.Name.startsWith(`/${state.resourcePrefix}u-`) ||
    container.Config.Labels["io.openapp.notes-demo.managed"] !== "true"
  )
    throw Error("unexpected workload identity");
  docker(["stop", id]);
}
docker([
  "compose",
  "--project-directory",
  join(release, "core"),
  "--env-file",
  join(release, "core/.env"),
  "-f",
  join(release, "core/docker-compose.yml"),
  "down",
]);
console.log(
  `Stopped workspaces and removed ${state.project} control containers/networks; database, user volumes and evidence retained.`,
);
