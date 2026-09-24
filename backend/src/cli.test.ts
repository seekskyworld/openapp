import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("openappctl sends admin bearer and session credentials to Portal", async (t) => {
  const requests: Array<{ method: string; path: string; authorization?: string; adminToken?: string; cookie?: string; contentType?: string; contentLength?: string; imageReference?: string; ifMatch?: string; body: Buffer }> = [];
  let operationWaitReads = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const imageReference = request.headers["x-image-reference"];
    requests.push({ method: request.method ?? "", path: request.url ?? "", authorization: request.headers.authorization, adminToken: request.headers["x-openapp-admin-token"] as string | undefined, cookie: request.headers.cookie, contentType: request.headers["content-type"], contentLength: request.headers["content-length"], imageReference: Array.isArray(imageReference) ? imageReference[0] : imageReference, ifMatch: Array.isArray(request.headers["if-match"]) ? request.headers["if-match"][0] : request.headers["if-match"], body: Buffer.concat(chunks) });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify({ ok: true }));
    else if (request.url?.endsWith("/upload-schema")) response.end(JSON.stringify({ requirements: [{ key: "application" }, { key: "assets" }] }));
    else if (request.url === "/api/admin/operations/operation-wait") {
      operationWaitReads += 1;
      response.end(JSON.stringify({ operation: { id: "operation-wait", status: operationWaitReads >= 2 ? "succeeded" : "running" } }));
    }
    else response.end(JSON.stringify({ users: [{ id: "u1", role: "admin" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;
  const latest = (method: string, path: string) => [...requests].reverse().find((request) => request.method === method && request.path === path);
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;

  const status = await execFileAsync(process.execPath, [cli, "--json", "--url", url, "status"]);
  assert.deepEqual(JSON.parse(status.stdout), { ok: true });
  const users = await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "users", "list"]);
  assert.deepEqual(JSON.parse(users.stdout), { users: [{ id: "u1", role: "admin" }] });
  assert.equal(requests[1]?.adminToken, "admin-secret");
  assert.equal(requests[1]?.authorization, undefined);
  assert.equal(requests[1]?.cookie, undefined);

  const forwarding = await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "forwarding", "set", "https://portal.example.test"]);
  assert.deepEqual(JSON.parse(forwarding.stdout), { users: [{ id: "u1", role: "admin" }] });
  const forwardingSet = latest("PATCH", "/api/admin/forwarding");
  assert.ok(forwardingSet);
  assert.equal(forwardingSet.ifMatch, "0");
  assert.deepEqual(JSON.parse(forwardingSet.body.toString("utf8")), { targetBaseUrl: "https://portal.example.test" });
  assert.equal((latest("GET", "/api/admin/forwarding")?.adminToken), "admin-secret");

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "forwarding", "disable"]);
  const forwardingDisable = latest("PATCH", "/api/admin/forwarding");
  assert.ok(forwardingDisable);
  assert.equal(forwardingDisable.ifMatch, "0");
  assert.deepEqual(JSON.parse(forwardingDisable.body.toString("utf8")), { enabled: false });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "forwarding", "allow", "https://portal.example.test", "*.internal.example.test"]);
  const forwardingAllow = latest("PATCH", "/api/admin/forwarding");
  assert.ok(forwardingAllow);
  assert.equal(forwardingAllow.ifMatch, "0");
  assert.deepEqual(JSON.parse(forwardingAllow.body.toString("utf8")), {
    allowedHosts: ["https://portal.example.test", "*.internal.example.test"],
  });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "forwarding", "test", "https://portal.example.test"]);
  const forwardingTest = latest("POST", "/api/admin/forwarding/test");
  assert.ok(forwardingTest);
  assert.deepEqual(JSON.parse(forwardingTest.body.toString("utf8")), { targetBaseUrl: "https://portal.example.test" });

  const directory = await mkdtemp(join(tmpdir(), "openapp-cli-test-"));
  const archive = join(directory, "image.tar");
  await writeFile(archive, Buffer.from("tar fixture"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loaded = await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "images", "load", archive, "openapp:fixture"]);
  assert.deepEqual(JSON.parse(loaded.stdout), { users: [{ id: "u1", role: "admin" }] });
  const imageLoad = latest("POST", "/api/admin/images/load");
  assert.ok(imageLoad);
  assert.equal(imageLoad.contentType, "application/x-tar");
  assert.equal(imageLoad.contentLength, String(Buffer.byteLength("tar fixture")));
  assert.equal(imageLoad.imageReference, "openapp:fixture");
  assert.equal(imageLoad.body.toString("utf8"), "tar fixture");

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "build-packages", "list", "sample-app", "backend"]);
  assert.ok(latest("GET", "/api/admin/build-packages?strategyId=sample-app&key=backend"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "build-packages", "upload", "sample-app", "backend", archive]);
  const packageUpload = latest("POST", "/api/admin/build-packages?strategyId=sample-app&key=backend");
  assert.ok(packageUpload);
  assert.match(packageUpload.contentType ?? "", /^multipart\/form-data; boundary=/u);
  assert.match(packageUpload.body.toString("utf8"), /name="backend"; filename="image\.tar"/u);
  assert.match(packageUpload.body.toString("utf8"), /tar fixture/u);
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "build-packages", "delete", "package-1"]);
  assert.ok(latest("DELETE", "/api/admin/build-packages/package-1"));

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "image-artifacts", "list"]);
  assert.ok(latest("GET", "/api/admin/image-artifacts"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "image-artifacts", "delete", "artifact-1"]);
  assert.ok(latest("DELETE", "/api/admin/image-artifacts/artifact-1"));

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "cleanup", "preview"]);
  assert.ok(latest("GET", "/api/admin/resource-cleanup?keepPrevious=1"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "cleanup", "run"]);
  assert.deepEqual(
    JSON.parse(latest("POST", "/api/admin/resource-cleanup")?.body.toString("utf8") ?? "{}"),
    { keepPrevious: 1 },
  );
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "cleanup", "run", "3"]);
  assert.deepEqual(
    JSON.parse(latest("POST", "/api/admin/resource-cleanup")?.body.toString("utf8") ?? "{}"),
    { keepPrevious: 3 },
  );

  const environmentFile = join(directory, "environment.json");
  const configFilesFile = join(directory, "config-files.json");
  await writeFile(environmentFile, JSON.stringify({ FEATURE_FLAG: "enabled" }));
  await writeFile(configFilesFile, JSON.stringify({ ".claude/settings.json": "{}" }));

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "policy", "auto-create", "off"]);
  let policyPatch = latest("PATCH", "/api/admin/instance-policy");
  assert.ok(policyPatch);
  assert.deepEqual(JSON.parse(policyPatch.body.toString("utf8")), { autoCreateOnFirstVisit: false });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "policy", "detect-network", "on"]);
  policyPatch = latest("PATCH", "/api/admin/instance-policy");
  assert.ok(policyPatch);
  assert.deepEqual(JSON.parse(policyPatch.body.toString("utf8")), { detectNetworkActivity: true });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "policy", "detect-compute", "off"]);
  policyPatch = latest("PATCH", "/api/admin/instance-policy");
  assert.ok(policyPatch);
  assert.deepEqual(JSON.parse(policyPatch.body.toString("utf8")), { detectComputeActivity: false });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "policy", "resources", "4g", "2.5", "512"]);
  policyPatch = latest("PATCH", "/api/admin/instance-policy");
  assert.ok(policyPatch);
  assert.deepEqual(JSON.parse(policyPatch.body.toString("utf8")), { resources: { memory: "4g", cpus: "2.5", pidsLimit: 512 } });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "policy", "env", environmentFile]);
  policyPatch = latest("PATCH", "/api/admin/instance-policy");
  assert.ok(policyPatch);
  assert.deepEqual(JSON.parse(policyPatch.body.toString("utf8")), { environment: { FEATURE_FLAG: "enabled" } });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "policy", "config-files", configFilesFile]);
  policyPatch = latest("PATCH", "/api/admin/instance-policy");
  assert.ok(policyPatch);
  assert.deepEqual(JSON.parse(policyPatch.body.toString("utf8")), { configFiles: { ".claude/settings.json": "{}" } });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "policy", "max-instances", "25"]);
  policyPatch = latest("PATCH", "/api/admin/instance-policy");
  assert.ok(policyPatch);
  assert.deepEqual(JSON.parse(policyPatch.body.toString("utf8")), { maxTotalInstances: 25 });

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "maintenance", "sweep"]);
  assert.ok(latest("POST", "/api/admin/maintenance/sweep"));

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "user", "--token", "user-secret", "containers", "list"]);
  const userContainers = latest("GET", "/api/containers");
  assert.ok(userContainers);
  assert.match(userContainers.cookie ?? "", /openapp_portal_session=user-secret/);
  assert.equal(userContainers.adminToken, undefined);
  assert.equal(userContainers.authorization, undefined);

  await execFileAsync(process.execPath, [
    cli,
    "--json",
    "--url",
    url,
    "--identity",
    "user",
    "--token",
    "legacy-user-secret",
    "--cookie-name",
    "sample-app_portal_session",
    "containers",
    "list",
  ]);
  assert.match(latest("GET", "/api/containers")?.cookie ?? "", /sample-app_portal_session=legacy-user-secret/);

  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "containers", "rebuild", "instance-1"]);
  assert.ok(latest("POST", "/api/admin/containers/instance-1/rebuild"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "containers", "upgrade", "instance-1"]);
  const upgraded = latest("POST", "/api/admin/containers/instance-1/rebuild");
  assert.ok(upgraded);
  assert.deepEqual(JSON.parse(upgraded.body.toString("utf8")), { useLatestVersion: true });


  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "list"]);
  assert.ok(latest("GET", "/api/admin/apps"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "create", "story-app", "Story App"]);
  assert.deepEqual(JSON.parse(latest("POST", "/api/admin/apps")?.body.toString("utf8") ?? "{}"), { id: "story-app", name: "Story App" });
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "update", "story-app", "archived"]);
  assert.ok(latest("PATCH", "/api/admin/apps/story-app"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "versions", "list", "story-app"]);
  assert.ok(latest("GET", "/api/admin/apps/story-app/versions"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "versions", "upload", "story-app", archive, archive]);
  assert.ok(latest("POST", "/api/admin/apps/story-app/versions"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "versions", "image", "attach", "story-app", "version-1", "story-runtime:1"]);
  assert.deepEqual(JSON.parse(latest("POST", "/api/admin/apps/story-app/versions/version-1/image")?.body.toString("utf8") ?? "{}"), { reference: "story-runtime:1" });
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "versions", "activate", "story-app", "version-1"]);
  assert.ok(latest("POST", "/api/admin/apps/story-app/versions/version-1/activate"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "image", "update", "story-app", "7", "backend=package-backend-2", "web=package-web-4"]);
  assert.deepEqual(
    JSON.parse(latest("POST", "/api/admin/apps/story-app/image-updates")?.body.toString("utf8") ?? "{}"),
    {
      expectedRevision: 7,
      replacementPackageIds: { backend: "package-backend-2", web: "package-web-4" },
    },
  );
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "apps", "image", "bind", "story-app", "revision-8", "7"]);
  assert.deepEqual(
    JSON.parse(latest("POST", "/api/admin/apps/story-app/image-updates/revision-8/bind")?.body.toString("utf8") ?? "{}"),
    { expectedRevision: 7 },
  );
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "monitor", "instances", "running"]);
  assert.ok(latest("GET", "/api/admin/monitor/instances?status=running"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "monitor", "metrics", "instance-1"]);
  assert.ok(latest("GET", "/api/admin/monitor/instances/instance-1/metrics"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "health"]);
  assert.ok(latest("GET", "/api/admin/monitor/health"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "audit"]);
  assert.ok(latest("GET", "/api/admin/audit"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "operations", "list", "failed"]);
  assert.ok(latest("GET", "/api/admin/operations?status=failed"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "operations", "get", "operation-1"]);
  assert.ok(latest("GET", "/api/admin/operations/operation-1"));
  const waited = await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "operations", "wait", "operation-wait"]);
  assert.equal(JSON.parse(waited.stdout).operation.status, "succeeded");
  assert.equal(operationWaitReads, 2);
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "operations", "cancel", "operation-1"]);
  assert.ok(latest("POST", "/api/admin/operations/operation-1/cancel"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "config-revisions", "instance-policy", "list"]);
  assert.ok(latest("GET", "/api/admin/config-revisions/instance-policy"));
  await execFileAsync(process.execPath, [cli, "--json", "--url", url, "--identity", "admin", "--token", "admin-secret", "config-revisions", "instance-policy", "rollback", "2"]);
  const revisionRollback = latest("POST", "/api/admin/config-revisions/instance-policy/2/rollback");
  assert.ok(revisionRollback);
  assert.equal(revisionRollback.ifMatch, "0");
});
