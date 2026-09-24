/** 使用独立内存服务验证浏览器边界，不触碰任何持久用户数据。 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPortalContextAsync } from "./portal-context-core.js";
import { createPortalApp } from "./portal-app.js";
import { loadGenericConfig } from "./config-core.js";
import { safeRequestPath } from "./http-security.js";

test("API rejects untrusted browser writes and non-JSON bodies while CLI and allowed origins work", async () => {
  const environment = {
    OPENAPP_CONTROL_PLANE_ONLY: "true",
    AUTH_PROVIDER: "none",
    DOCKER_HOST: "tcp://127.0.0.1:9",
    PORTAL_PUBLIC_BASE_URL: "https://portal.example.test",
  };
  const context = await createPortalContextAsync({
    environment,
    config: { ...loadGenericConfig(environment), host: "127.0.0.1", port: 0 },
  });
  const app = createPortalApp(context);
  await app.start();
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const body = JSON.stringify({ email: "security@example.test", password: "Security-test-password-2026!" });
  const post = (route: string, headers: Record<string, string>) =>
    fetch(base + route, { method: "POST", body, headers });
  try {
    assert.equal((await fetch(base + "/api/ready")).status, 200);
    const checkReady = context.stores.checkReady;
    context.stores.checkReady = async () => {
      throw Error("private database URL");
    };
    const unavailable = await fetch(base + "/api/ready");
    assert.equal(unavailable.status, 503);
    assert.doesNotMatch(await unavailable.text(), /private database/);
    assert.equal((await fetch(base + "/api/health")).status, 200);
    context.stores.checkReady = checkReady;
    for (const origin of ["https://untrusted.example.test", "null"]) {
      const result = await post("/api/auth/local/register", { origin, "content-type": "text/plain" });
      assert.equal(result.status, 403);
      assert.equal(result.headers.get("set-cookie"), null);
    }
    assert.equal((await post("/api/auth/local/register", { "content-type": "text/plain" })).status, 415);
    assert.equal(
      (
        await post("/api/auth/local/register", {
          "content-type": "application/json",
          "sec-fetch-site": "cross-site",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post("/api/auth/local/register", { "content-type": "application/json" })).status,
      201,
    );
    const login = await post("/api/auth/local/login", {
      "content-type": "application/json; charset=utf-8",
      origin: "https://portal.example.test",
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const logout = await fetch(base + "/api/auth/logout", {
      method: "POST",
      headers: { cookie, origin: "https://untrusted.example.test" },
    });
    assert.equal(logout.status, 403);
    assert.equal((await fetch(base + "/api/auth/me", { headers: { cookie } })).status, 200);
  } finally {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
});

test("direct static hosting serves modules and mutable catalogs correctly without HTML fallback or symlink escape", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openapp-static-test-"));
  const root = join(directory, "public");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(root);
  await writeFile(join(root, "index.html"), "<html>Portal</html>");
  await writeFile(join(root, "auth-ui.mjs"), "export const apiVersion = 1;");
  await writeFile(join(root, "auth-adapters.json"), "{}");
  await writeFile(join(directory, "private.txt"), "private");
  await symlink(join(directory, "private.txt"), join(root, "escape.txt"));
  const environment = { OPENAPP_CONTROL_PLANE_ONLY: "true", AUTH_PROVIDER: "none" };
  const context = await createPortalContextAsync({
    environment,
    config: { ...loadGenericConfig(environment), host: "127.0.0.1", port: 0, staticDir: root },
  });
  const app = createPortalApp(context);
  await app.start();
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const module = await fetch(base + "/auth-ui.mjs");
    assert.match(module.headers.get("content-type")!, /javascript/);
    assert.equal(module.headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(base + "/auth-adapters.json")).headers.get("cache-control"), "no-store");
    assert.equal((await fetch(base + "/missing.mjs")).status, 404);
    assert.equal((await fetch(base + "/control")).status, 200);
    assert.equal((await fetch(base + "/escape.txt")).status, 403);
    assert.equal(await (await fetch(base + "/auth-ui.mjs", { method: "HEAD" })).text(), "");
  } finally {
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("request diagnostics omit query credentials and account path identifiers", () => {
  assert.equal(
    safeRequestPath("/api/admin/users/member%40example.test?token=secret"),
    "/api/admin/users/[account]",
  );
});
