import assert from "node:assert/strict";
import test from "node:test";

import type { AccessTarget, AccessTargetResolver } from "./execution-provider.js";
import { ProviderOperationError } from "./execution-provider.js";
import { resolveWorkspaceAccessTarget } from "./workspace-access-target.js";

test("AccessTarget validation clones trusted private routing data", async () => {
  const source = target({
    url: new URL("https://provider.internal/private/base?signature=secret"),
    authority: "Workspace.Provider.Internal:8443",
    headers: { "X-Provider-Token": "secret" },
    expiresAt: "2026-08-04T00:01:00.000Z",
  });
  const resolved = await resolveWorkspaceAccessTarget(resolver(source), request(), () => Date.parse("2026-08-04T00:00:00.000Z"));

  source.url.pathname = "/mutated";
  assert.equal(resolved.url.href, "https://provider.internal/private/base?signature=secret");
  assert.equal(resolved.authority, "workspace.provider.internal:8443");
  assert.deepEqual(resolved.headers, { "x-provider-token": "secret" });
  assert.equal(Object.isFrozen(resolved.headers), true);
});

test("AccessTarget validation fails closed for invalid routing metadata", async () => {
  const invalidTargets = [
    target({ environmentRef: " environment-1" }),
    target({ logicalService: "mcp_sandbox_asset" }),
    target({ url: new URL("file:///tmp/workspace") }),
    target({ authority: "provider.internal\r\nx-injected: yes" }),
    target({ headers: { host: "attacker.internal" } }),
    target({ headers: { "x-provider-token": "secret\r\nx-injected: yes" } }),
    target({ expiresAt: "not-a-timestamp" }),
  ];

  for (const invalid of invalidTargets) {
    await assert.rejects(
      resolveWorkspaceAccessTarget(resolver(invalid), request()),
      (error: unknown) => error instanceof ProviderOperationError
        && error.code === "provider_access_target_invalid"
        && error.failureClass === "inconsistent",
    );
  }
});

test("AccessTarget validation classifies expiry and hides resolver failures", async () => {
  await assert.rejects(
    resolveWorkspaceAccessTarget(
      resolver(target({ expiresAt: "2026-08-04T00:00:00.000Z" })),
      request(),
      () => Date.parse("2026-08-04T00:00:00.000Z"),
    ),
    (error: unknown) => error instanceof ProviderOperationError
      && error.code === "provider_access_target_expired"
      && error.retryAfterMs === 0,
  );

  const failingResolver: AccessTargetResolver = {
    async resolveAccessTarget() {
      throw new Error("https://private.internal?token=must-not-leak");
    },
  };
  await assert.rejects(
    resolveWorkspaceAccessTarget(failingResolver, request()),
    (error: unknown) => error instanceof ProviderOperationError
      && error.message === "provider_access_target_resolution_failed"
      && !error.message.includes("private.internal"),
  );
});

function request() {
  return {
    workspaceId: "workspace-1",
    expectedOwnerId: "owner-1",
    logicalService: "workspace_ui" as const,
  };
}

function resolver(value: AccessTarget): AccessTargetResolver {
  return { async resolveAccessTarget() { return value; } };
}

function target(overrides: Partial<AccessTarget> = {}): AccessTarget {
  return {
    providerId: "provider-1",
    environmentRef: "environment-1",
    logicalService: "workspace_ui",
    url: new URL("http://127.0.0.1:37371"),
    expiresAt: null,
    ...overrides,
  };
}
