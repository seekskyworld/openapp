/** 在一次性目录和独立 Compose 项目验收真实部署包；不继承生产配置或挂载。 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  isolatedAcceptanceEnvironment,
  dockerAcceptanceEnvironment,
} from "../openapp-acceptance-environment.mjs";
const exec = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");

test(
  "fresh Core deployment bootstraps once, authenticates, migrates twice and survives restart",
  {
    skip:
      process.env.OPENAPP_CLEAN_INSTALL_TEST !== "1"
        ? "OPENAPP_CLEAN_INSTALL_TEST=1 is required (Docker)"
        : false,
    timeout: 900000,
  },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "openapp-install-"));
    const release = join(directory, "release");
    const core = join(release, "core");
    const project = `openapp-install-${randomBytes(6).toString("hex")}`;
    const env = {
      ...isolatedAcceptanceEnvironment(process.env),
      ...dockerAcceptanceEnvironment(process.env),
    };
    // 仅允许显式构建工具参数；业务环境和服务器密码始终不继承。
    for (const key of [
      "NODE_BASE_IMAGE",
      "DOCKER_CLI_IMAGE",
      "NGINX_BASE_IMAGE",
      "NPM_REGISTRY",
      "DEBIAN_MIRROR",
      "TARGET_PLATFORM",
    ]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const run = (command, args, options = {}) =>
      exec(command, args, { cwd: repository, env, maxBuffer: 8 * 1024 * 1024, timeout: 600000, ...options });
    let composeReady = false;
    const compose = (args) =>
      run("docker", [
        "compose",
        "--project-name",
        project,
        "--project-directory",
        core,
        "--env-file",
        join(core, ".env"),
        "-f",
        join(core, "docker-compose.yml"),
        ...args,
      ]);
    t.after(async () => {
      if (composeReady) {
        // 仅删除本测试随机项目的容器/网络；若清理失败保留目录，便于人工恢复。
        await compose(["down", "--volumes", "--remove-orphans"]);
        await run("docker", [
          "run",
          "--rm",
          "--user",
          "0",
          "--entrypoint",
          "chmod",
          "--mount",
          `type=bind,src=${join(directory, "data")},dst=/test-data`,
          "postgres:17-alpine",
          "-R",
          "a+rwX",
          "/test-data",
        ]);
      }
      await rm(directory, { recursive: true, force: true });
    });
    process.stdout.write("[install] exporting Core-only release\n");
    await run(process.execPath, ["scripts/export-openapp.mjs", "config/core.release.json", release]);
    process.stdout.write("[install] building deployment images\n");
    await run("bash", [join(release, "build-images.sh")]);
    const manifest = JSON.parse(await readFile(join(release, "release-manifest.json"), "utf8"));
    const data = join(directory, "data");
    for (const path of ["postgres/data", "postgres/init", "openapp", "frontend/nginx/logs"])
      await mkdir(join(data, path), { recursive: true });
    const password = randomBytes(24).toString("hex");
    let settings = await readFile(join(core, ".env.example"), "utf8");
    const values = {
      COMPOSE_PROJECT_NAME: project,
      OPENAPP_DATA_ROOT: data,
      POSTGRES_PASSWORD: randomBytes(24).toString("hex"),
      OPENAPP_ADMIN_CLI_TOKEN: randomBytes(24).toString("hex"),
      PORTAL_PORT: "0",
      PORTAL_BACKEND_PORT: "0",
      BACKEND_IMAGE: `openapp-portal-backend:release-${manifest.sourceFingerprint.slice(0, 12)}`,
      FRONTEND_IMAGE: `openapp-frontend:release-${manifest.sourceFingerprint.slice(0, 12)}`,
    };
    for (const [key, value] of Object.entries(values))
      settings = settings.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`);
    await writeFile(join(core, ".env"), settings, { mode: 0o600 });
    await run("docker", [
      "run",
      "--rm",
      "--user",
      "0",
      "--entrypoint",
      "chown",
      "--mount",
      `type=bind,src=${join(data, "openapp")},dst=/test-releases`,
      values.BACKEND_IMAGE,
      "10001:10001",
      "/test-releases",
    ]);
    const model = JSON.parse((await compose(["config", "--format", "json"])).stdout);
    assert.equal(model.services["docker-socket-proxy"], undefined);
    for (const service of Object.values(model.services)) {
      assert.ok(service.container_name.startsWith(project));
      assert.ok(!(service.volumes ?? []).some((v) => v.source === "/var/run/docker.sock"));
    }
    composeReady = true;
    process.stdout.write("[install] starting isolated services and verifying administrator\n");
    try {
      await compose([
        "up",
        "-d",
        "--no-build",
        "--wait",
        "--wait-timeout",
        "120",
        "postgres",
        "portal-backend",
        "frontend",
      ]);
      const origin = `http://${(await compose(["port", "frontend", "80"])).stdout.trim()}`;
      const request = async (path, init) =>
        fetch(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(15000) });
      // Compose 的 started 不代表 Nginx 已监听；只重试幂等探针，避免重复提交写请求。
      const waitForFrontend = async () => {
        const deadline = Date.now() + 30_000;
        let failure;
        while (Date.now() < deadline) {
          try {
            const response = await request("/api/ready");
            await response.arrayBuffer();
            if (response.ok) return;
            failure = new Error(`frontend readiness returned ${response.status}`);
          } catch (error) {
            failure = error;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error("frontend did not become ready", { cause: failure });
      };
      await waitForFrontend();
      assert.equal((await request("/control")).status, 200);
      const methods = await (await request("/api/auth/methods")).json();
      assert.deepEqual(methods.external, []);
      assert.equal(methods.compatibilityMode, false);
      const bootstrapEnv = {
        ...env,
        OPENAPP_BOOTSTRAP_SUPER_ADMIN_EMAIL: "admin@example.test",
        OPENAPP_BOOTSTRAP_SUPER_ADMIN_PASSWORD: password,
      };
      await run("bash", [join(core, "bootstrap-admin.sh")], { cwd: core, env: bootstrapEnv });
      const login = async () => {
        const response = await request("/api/auth/local/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "admin@example.test", password }),
        });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).user.role, "super_admin");
        return response.headers.get("set-cookie").split(";")[0];
      };
      let cookie = await login();
      const users = await request("/api/admin/users", { headers: { Cookie: cookie } });
      assert.equal(users.status, 200);
      await assert.rejects(
        run("bash", [join(core, "bootstrap-admin.sh")], {
          cwd: core,
          env: { ...bootstrapEnv, OPENAPP_BOOTSTRAP_SUPER_ADMIN_PASSWORD: randomBytes(24).toString("hex") },
        }),
        /already exists/,
      );
      for (let i = 0; i < 2; i++)
        await compose(["exec", "-T", "portal-backend", "node", "dist/migrate-generic.js"]);
      await compose(["restart", "portal-backend"]);
      await compose(["up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "portal-backend"]);
      await waitForFrontend();
      cookie = await login();
      assert.equal((await request("/api/admin/users", { headers: { Cookie: cookie } })).status, 200);
      const count = await compose([
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "container_service",
        "-d",
        "container_service",
        "-Atc",
        "SELECT count(*) FROM users WHERE role='super_admin'",
      ]);
      assert.equal(count.stdout.trim(), "1");
      t.diagnostic(
        "Fresh database, modern Core-only auth, bootstrap conflict, repeated migration and restart passed.",
      );
    } catch (error) {
      const logs = await compose(["logs", "--no-color", "--tail", "60", "portal-backend", "frontend"]).catch(
        () => ({ stdout: "" }),
      );
      t.diagnostic(logs.stdout);
      throw error;
    }
  },
);
