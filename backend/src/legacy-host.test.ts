import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterLegacyIntegration } from "@openapp/contracts";
import {
  createLegacyCompatibilityHost,
  createLegacyPortalCompatibilityBoundary,
} from "./legacy-host.js";

test('email-code projection is isolated to its declared provider and cannot mutate the result', () => {
  const value = { providerData: { challenge: true } };
  const host = createLegacyCompatibilityHost(legacyFixture({ projection: {
    id: 'challenge-projection', version: '1',
    projectEmailCodeResponse(input) {
      const result = input as typeof value;
      result.providerData.challenge = false;
      return { legacyChallenge: true };
    },
  } }));
  assert.deepEqual(host.projectEmailCodeResponse('another-provider', value), {});
  assert.deepEqual(host.projectEmailCodeResponse('sso', value), { legacyChallenge: true });
  assert.equal(value.providerData.challenge, true);
});

function legacyFixture(overrides: Partial<AdapterLegacyIntegration> = {}): AdapterLegacyIntegration {
  const routes = {
    auth: ["/legacy/auth/email-codes", "/legacy/auth/login"],
  } as const;
  return {
    routes,
    auth: { providerId: "sso", routeAliases: routes },
    projection: {
      id: "legacy-projection",
      version: "1",
      projectAdminConfig(value) {
        const input = value as { authProvider?: string };
        return { legacyConfigured: input.authProvider === "sso" };
      },
      projectRuntimeStatus(value) {
        const input = value as { providerId?: string; available?: boolean };
        return { legacyRuntime: input.providerId, available: input.available };
      },
    },
    ...overrides,
  };
}

test("legacy host resolves only declared auth aliases", () => {
  const host = createLegacyCompatibilityHost(legacyFixture());

  assert.deepEqual(host.resolveAuthRoute("/legacy/auth/email-codes"), {
    operation: "email-code",
    providerId: "sso",
  });
  assert.deepEqual(host.resolveAuthRoute("/legacy/auth/login/"), {
    operation: "login",
    providerId: "sso",
  });
  assert.equal(host.resolveAuthRoute("/legacy/auth/unknown"), undefined);
  assert.equal(host.resolveAuthRoute("/legacy/auth/login?probe=1"), undefined);
});

test("legacy host invokes pure projections without freezing caller input", () => {
  const input = {
    authProvider: "sso",
    runtimeImageConfigured: false,
    nested: { keep: true },
  };
  const status = {
    providerId: "provider-a",
    available: true,
    capabilityStatus: "supported" as const,
  };
  const host = createLegacyCompatibilityHost(legacyFixture());

  const config = host.projectAdminConfig(input);
  const projectedStatus = host.projectRuntimeStatus(status) as Record<string, unknown>;
  assert.deepEqual(config, { legacyConfigured: true });
  assert.deepEqual(projectedStatus, { legacyRuntime: "provider-a", available: true });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(projectedStatus), true);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(status), false);
});

test("legacy host clones cyclic projection input before freezing the result", () => {
  const projectionInput: { nested?: { value: string; self?: unknown } } = {
    nested: { value: "preserve" },
  };
  projectionInput.nested!.self = projectionInput.nested;
  const host = createLegacyCompatibilityHost({
    projection: {
      id: "cyclic-projection",
      version: "1",
      projectApp(value) {
        return { nested: (value as typeof projectionInput).nested };
      },
    },
  });
  const projected = host.projectApp(projectionInput) as {
    nested: { value: string; self: unknown };
  };
  assert.notEqual(projected.nested, projectionInput.nested);
  assert.equal(projected.nested.self, projected.nested);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.nested), true);
  assert.equal(Object.isFrozen(projectionInput), false);
  assert.equal(Object.isFrozen(projectionInput.nested), false);
});

test("legacy host exposes a read-only migration descriptor and pure transform", () => {
  const host = createLegacyCompatibilityHost(legacyFixture({
    migration: {
      plan: {
        id: "legacy-to-current",
        fromSchema: "legacy-v1",
        toSchema: "openapp-v1",
        checksum: "a".repeat(64),
        strategy: "transform",
        preserves: ["users", "workspaces"],
      },
      transform(value) {
        const row = value as { value: number };
        return { value: row.value + 1 };
      },
    },
  }));
  const migration = host.migrationForApp();
  assert.ok(migration);
  assert.deepEqual(migration.plan.preserves, ["users", "workspaces"]);
  assert.deepEqual(migration.transform?.({ value: 4 }), { value: 5 });
  assert.throws(() => {
    (migration.plan.preserves as string[])[0] = "audit";
  }, TypeError);
  assert.deepEqual(host.migrationForApp()?.plan.preserves, ["users", "workspaces"]);
});

test("legacy portal boundary is generic host output and honors image aliases", () => {
  const boundary = createLegacyPortalCompatibilityBoundary(legacyFixture(), {
    runtimeImageEnvironmentKeys: ["LEGACY_RUNTIME_IMAGE"],
  });
  assert.equal(boundary.mode, "legacy");
  assert.equal(boundary.isRuntimeImageConfigured({ LEGACY_RUNTIME_IMAGE: "runtime:test" }), true);
  assert.equal(boundary.isRuntimeImageConfigured({ OPENAPP_RUNTIME_IMAGE: "" }), false);
  assert.deepEqual(boundary.resolveAuthRoute("/legacy/auth/login"), {
    operation: "login",
    providerId: "sso",
  });
});

test("legacy host rejects malformed descriptors before exposing a route", () => {
  assert.throws(
    () => createLegacyCompatibilityHost({ routes: { auth: ["../unsafe"] } }),
    /adapter_legacy_route_invalid/u,
  );
});

test("legacy host rejects catalog and runtime descriptors with different contracts", () => {
  assert.throws(
    () => createLegacyCompatibilityHost({
      catalog: {
        appId: "legacy-app",
        bootstrap: {
          version: "1.0.0",
          imageReference: "legacy:1",
          runtimeContract: "legacy-v1",
        },
      },
      runtime: {
        profile: {
          id: "legacy-runtime",
          contract: "other-v1",
          labelPrefix: "legacy",
          storageClass: "workspace",
          storageMountPath: "/var/lib/workspace",
          containerPort: 8080,
          containerUser: "app",
          entrypoint: "/bin/start",
          command: ["serve"],
          recoveryCommand: ["/bin/recover"],
          configEnvironmentKey: "LEGACY_CONFIG",
          lockRecoveryEnvironment: {
            containers: "LEGACY_LOCK_CONTAINERS",
            hosts: "LEGACY_LOCK_HOSTS",
            recoveryId: "LEGACY_LOCK_ID",
          },
          reservedEnvironment: [],
          healthPath: "/health",
        },
      },
    }),
    /adapter_legacy_runtime_contract_mismatch/u,
  );
});
