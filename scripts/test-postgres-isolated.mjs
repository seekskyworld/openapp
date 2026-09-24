/** 只创建并清理本次随机命名的 PostgreSQL，拒绝继承部署环境。 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  isolatedAcceptanceEnvironment,
  dockerAcceptanceEnvironment,
} from "./openapp-acceptance-environment.mjs";
const name = `openapp-pg-test-${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("hex");
const env = { ...isolatedAcceptanceEnvironment(process.env), ...dockerAcceptanceEnvironment(process.env) };
const docker = (args) =>
  execFileSync("docker", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let created = false;
try {
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    "127.0.0.1::5432",
    "--env",
    "POSTGRES_USER=openapp_test",
    "--env",
    "POSTGRES_DB=openapp_test",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "postgres:17-alpine@sha256:f02121de6f74d30d8a94cd1d9584125e2178d7e6c377d8130112d4e52d867995",
  ]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      docker(["exec", name, "pg_isready", "-U", "openapp_test"]);
      ready = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!ready) throw Error("disposable PostgreSQL did not become ready");
  const port = docker(["port", name, "5432/tcp"]).split(":").at(-1);
  execFileSync("npm", ["run", "test:postgres", "--prefix", "backend"], {
    env: { ...env, POSTGRES_TEST_URL: `postgres://openapp_test:${password}@127.0.0.1:${port}/openapp_test` },
    stdio: "inherit",
  });
} finally {
  if (created) docker(["rm", "--force", "--volumes", name]);
}
