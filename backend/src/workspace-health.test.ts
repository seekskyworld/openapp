import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WORKSPACE_HEALTH_PATH,
  resolveWorkspaceHealthPath,
  workspaceHealthUrl,
} from "./workspace-health.js";

test("workspace health path defaults to the neutral Portal workload contract", () => {
  assert.equal(resolveWorkspaceHealthPath(), DEFAULT_WORKSPACE_HEALTH_PATH);
  assert.equal(
    workspaceHealthUrl("http://127.0.0.1:37371", DEFAULT_WORKSPACE_HEALTH_PATH).pathname,
    "/api/health",
  );
});

test("workspace health probes honor an Adapter-defined path and endpoint prefix", () => {
  const path = resolveWorkspaceHealthPath({ healthPath: "/healthz/" });
  const url = workspaceHealthUrl("http://workload.test/instances/demo/?token=opaque", path);
  assert.equal(path, "/healthz");
  assert.equal(url.href, "http://workload.test/instances/demo/healthz?token=opaque");
});

test("workspace health paths reject traversal and URL injection", () => {
  for (const invalid of ["healthz", "/../healthz", "/health?token=secret", "/health#fragment", "/health/./check"]) {
    assert.throws(() => resolveWorkspaceHealthPath({ healthPath: invalid }), /workspace_health_path_invalid/u);
    assert.throws(() => workspaceHealthUrl("http://workload.test", invalid), /workspace_health_path_invalid/u);
  }
});
