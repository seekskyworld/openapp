import assert from "node:assert/strict";
import test from "node:test";
import { createPortalContextAsync } from "./portal-context-core.js";
import { createPortalApp } from "./portal-app.js";
import { loadGenericConfig } from "./config-core.js";
import { AppCatalogError } from "./models.js";

// 独立控制面必须支持未安装应用插件的旧账户，且不能恢复工作负载任务。
test("control-plane-only permits local sessions without an app handoff and blocks workload writes", async () => {
  const environment = { OPENAPP_CONTROL_PLANE_ONLY: "true", AUTH_PROVIDER: "none", DOCKER_HOST: "tcp://127.0.0.1:9" };
  const context = await createPortalContextAsync({ environment, config: { ...loadGenericConfig(environment), port: 0, adminCliToken: 'test-control-cli-token' } });
  assert.equal(context.plugins.list().length, 0);
  context.catalog.initialize = async () => { throw Error("unexpected catalog initialization"); };
  context.monitoring.start = () => { throw Error("unexpected monitoring"); };
  const app = createPortalApp(context);
  await app.start();
  try {
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const entry = await fetch(`${base}/api/entry/manifest`);
    assert.equal(entry.status, 409);
    assert.equal((await entry.json()).error, 'adapter_not_configured');
    const response = await fetch(`${base}/api/auth/local/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "control@example.test", password: "Test-password-2026!" }) });
    assert.equal(response.status, 201);
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    const me = await fetch(`${base}/api/auth/me`, { headers: { cookie } });
    assert.equal((await me.json() as { authenticated: boolean }).authenticated, true);
    const methods = await fetch(`${base}/api/auth/methods`);
    assert.deepEqual((await methods.json() as { external: unknown[] }).external, []);
    context.imageBuilds.listStrategies = async () => [{ id: 'sample-build', revision: 1, name: 'Sample', description: '', runtimeContract: 'sample-v1', packageRequirements: [], status: 'active', createdAt: '', updatedAt: '' }];
    const strategies = await fetch(`${base}/api/admin/build-strategies`, { headers: { 'x-openapp-admin-token': 'test-control-cli-token' } });
    assert.equal(strategies.status, 200);
    const strategy = (await strategies.json() as { strategies: Array<{ executable: boolean; unavailableReason: string }> }).strategies[0]!;
    assert.equal(strategy.executable, false);
    assert.equal(strategy.unavailableReason, 'control_plane_only');
    context.catalog.listLaunchableApps = async () => { throw new AppCatalogError("runtime_image_contract_unsupported", 501); };
    const catalog = await fetch(`${base}/api/apps`, { headers: { cookie } });
    assert.equal(catalog.status, 501);
    assert.equal((await catalog.json() as { error: string }).error, "runtime_image_contract_unsupported");
    context.catalog.listLaunchableApps = async () => { throw new Error("private diagnostic detail"); };
    const failedCatalog = await fetch(`${base}/api/apps`, { headers: { cookie } });
    assert.equal(failedCatalog.status, 500);
    assert.equal((await failedCatalog.json() as { error: string }).error, "internal_error");
    const mutation = await fetch(`${base}/api/containers`, { method: "POST", headers: { cookie } });
    assert.equal(mutation.status, 409);
    assert.equal((await mutation.json() as { error: string }).error, "control_plane_only_operation_unavailable");
  } finally {
    app.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.server.close(error => error ? reject(error) : resolve()));
  }
});

test("control-plane-only rejects configured product modules instead of silently loading them", async () => {
  await assert.rejects(createPortalContextAsync({ environment: {
    OPENAPP_CONTROL_PLANE_ONLY: "true", AUTH_PROVIDER: "none", OPENAPP_ADAPTER_MODULE: "/unavailable/adapter.js",
  } }), /control_plane_only_configuration_conflict/);
});
