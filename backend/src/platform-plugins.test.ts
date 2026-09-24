import assert from "node:assert/strict";
import test from "node:test";
import { PlatformPluginRegistry, type AppIntegrationPlugin } from "./platform-plugins.js";
import type { AdapterAuthProvider } from "@openapp/contracts";

function plugin(appId: string, overrides: Partial<AppIntegrationPlugin> = {}): AppIntegrationPlugin {
  return {
    appId,
    manifest: {
      id: appId,
      apiVersion: "v2",
      version: "1.0.0",
      authProviders: [],
      appIntegrations: [appId],
      buildStrategies: [],
      capabilities: {},
    },
    ...overrides,
  };
}

test("platform registry exposes immutable App plugin capabilities", () => {
  const entry = {
    id: "story",
    label: "Story",
    logoUrl: "/story.png",
    challenge: "email_code" as const,
    defaultWorkspace: "personal" as const,
  };
  const registry = new PlatformPluginRegistry([plugin("story", {
    manifest: {
      ...plugin("story").manifest,
      entryExperience: "story",
      capabilities: { websocket: true },
    },
    entryExperience: entry,
  })]);

  assert.equal(registry.get(" STORY ")?.appId, "story");
  assert.equal(registry.supportsCredentialedApp("story"), false);
  assert.deepEqual(registry.entryExperience("story"), entry);
  assert.deepEqual(registry.workspaceEntryManifest("story", "Story App"), {
    appId: "story",
    appName: "Story App",
    entry,
    capabilities: { websocket: true },
  });
  const manifests = registry.manifests();
  (manifests[0]!.capabilities as Record<string, boolean>).websocket = false;
  assert.equal(registry.manifests()[0]!.capabilities.websocket, true);
});

test("platform registry supplies a generic entry for an App without branding", () => {
  const registry = new PlatformPluginRegistry([plugin("plain")]);
  assert.deepEqual(registry.workspaceEntryManifest("plain", "Plain App"), {
    appId: "plain",
    appName: "Plain App",
    entry: {
      id: "generic-workspace",
      label: "Plain App",
      logoUrl: "/openapp-logo.png",
      challenge: "none",
      defaultWorkspace: "personal",
    },
    capabilities: {},
  });
});

test("platform registry exposes only declared execution contracts plus neutral platform contracts", () => {
  const generic = new PlatformPluginRegistry([plugin("plain", {
    manifest: { ...plugin("plain").manifest, executionContracts: ["story-v1"] },
  })]);
  assert.deepEqual(generic.executionContracts(), ["story-v1", "generic-v1", "none"]);

  const manifests = generic.manifests();
  assert.deepEqual(manifests[0]?.executionContracts, ["story-v1"]);
  assert.throws(
    () => new PlatformPluginRegistry([plugin("invalid", {
      manifest: { ...plugin("invalid").manifest, executionContracts: ["../sample-app"] },
    })]),
    /platform_plugin_invalid_execution_contracts/u,
  );
});

test("platform registry keeps catalog bootstrap metadata inside the App plugin", () => {
  const registry = new PlatformPluginRegistry([plugin("story", {
    catalogBootstrap: {
      app: { id: "story", name: "Story", description: "", authAdapterId: "none" },
      legacyVersion: { version: "1.0.0", imageReference: "story:1", runtimeContract: "story-v1" },
    },
  })]);
  assert.equal(registry.get("story")?.catalogBootstrap?.legacyVersion.runtimeContract, "story-v1");
});

test("platform registry derives a generic default App only for a single plugin", () => {
  const single = new PlatformPluginRegistry([plugin("story")]);
  assert.deepEqual(single.provisioningPolicyDefaults(), { defaultAppId: "story" });

  const multiple = new PlatformPluginRegistry([plugin("first"), plugin("second")]);
  assert.deepEqual(multiple.provisioningPolicyDefaults(), {});
});

test("platform registry rejects conflicting plugin policy defaults", () => {
  assert.throws(
    () => new PlatformPluginRegistry([
      plugin("first", { provisioningPolicyDefaults: { defaultAppId: "first" } }),
      plugin("second", { provisioningPolicyDefaults: { defaultAppId: "second" } }),
    ]),
    /platform_plugin_conflicting_default_app/u,
  );
});

test("platform registry rejects duplicate Apps and manifest mismatches", () => {
  assert.throws(
    () => new PlatformPluginRegistry([plugin("story"), plugin("story")]),
    /platform_plugin_duplicate_id/,
  );
  assert.throws(
    () => new PlatformPluginRegistry([plugin("story", {
      manifest: { ...plugin("story").manifest, id: "other" },
    })]),
    /platform_plugin_manifest_id_mismatch/,
  );
  assert.throws(
    () => new PlatformPluginRegistry([plugin("story", {
      manifest: { ...plugin("story").manifest, appIntegrations: [] },
    })]),
    /platform_plugin_manifest_app_mismatch/,
  );
});

test("platform registry exposes adapter compatibility metadata and migration plans", () => {
  const registry = new PlatformPluginRegistry([plugin("story", {
    compatibility: {
      legacyAliases: { appIds: ["story-legacy"], routeAliases: ["/story-old"] },
      errorCatalog: { en: { story_unavailable: "Story is unavailable." } },
      migration: {
        id: "story-legacy-to-v1",
        fromSchema: "story-legacy",
        toSchema: "openapp-v1",
        checksum: "a".repeat(64),
        strategy: "additive",
        preserves: ["users", "workspaces"],
      },
    },
  })]);
  assert.deepEqual(registry.compatibilityForApp("story")?.legacyAliases?.appIds, ["story-legacy"]);
  assert.equal(registry.migrationPlanForApp("story")?.strategy, "additive");
  assert.deepEqual(registry.workspaceEntryManifest("story")?.errorCatalog, {
    en: { story_unavailable: "Story is unavailable." },
  });
  const copy = registry.compatibilityForApp("story")!;
  assert.throws(() => {
    (copy.migration!.preserves as string[])[0] = "audit";
  }, TypeError);
  assert.deepEqual(registry.migrationPlanForApp("story")?.preserves, ["users", "workspaces"]);
});

test("platform registry rejects invalid and conflicting migration metadata", () => {
  assert.throws(
    () => new PlatformPluginRegistry([plugin("invalid", {
      compatibility: { errorCatalog: { en: { access_token: "secret" } } },
    })]),
    /platform_plugin_compatibility_invalid/u,
  );
  const plan = {
    id: "shared-migration",
    fromSchema: "legacy-v1",
    toSchema: "openapp-v1",
    checksum: "a".repeat(64),
    strategy: "transform" as const,
  };
  assert.throws(
    () => new PlatformPluginRegistry([
      plugin("first", { compatibility: { migration: plan } }),
      plugin("second", { compatibility: { migration: { ...plan, checksum: "b".repeat(64) } } }),
    ]),
    /platform_plugin_conflicting_migration_plan/u,
  );
});

test("platform registry rejects duplicate build strategy revisions", () => {
  const strategy = { id: "story-build", revision: 1, execute: async () => ({ imageReference: "x", imageId: "y" }) };
  assert.throws(
    () => new PlatformPluginRegistry([
      plugin("story", { manifest: { ...plugin("story").manifest, buildStrategies: ["story-build"] }, buildStrategies: [strategy] }),
      plugin("other", { manifest: { ...plugin("other").manifest, buildStrategies: ["story-build"] }, buildStrategies: [strategy] }),
    ]),
    /platform_plugin_duplicate_build_strategy/,
  );
});

test("platform registry creates only code-owned authentication providers", () => {
  const provider = {
    id: "story-auth",
    create: () => ({
      provider: "story-auth",
      async sendEmailCode() {},
      async login(input: { email: string; code: string }) {
        return { identity: { provider: "story-auth", subject: input.email, email: input.email } };
      },
    }),
  };
  const registry = new PlatformPluginRegistry([plugin("story", {
    manifest: {
      ...plugin("story").manifest,
      authProviders: ["story-auth"],
    },
    authProviders: [provider],
  })]);

  assert.equal(registry.createAuthService(" STORY-AUTH ")?.provider, "story-auth");
  assert.deepEqual(registry.authProviderIds(), ["story-auth"]);
  assert.equal(registry.createAuthService("missing"), undefined);
  const sharedProvider = { ...provider, id: "shared" };
  assert.throws(
    () => new PlatformPluginRegistry([plugin("first", {
      manifest: { ...plugin("first").manifest, authProviders: ["shared"] },
      authProviders: [sharedProvider],
    }), plugin("second", {
      manifest: { ...plugin("second").manifest, authProviders: ["shared"] },
      authProviders: [sharedProvider],
    })]),
    /platform_plugin_duplicate_auth_provider/,
  );
});

test("platform registry allows one explicitly shared Provider to be referenced by multiple Apps", () => {
  const firstFactory = {
    id: "shared-auth",
    scope: "platform" as const,
    create: () => ({
      provider: "shared-auth",
      async sendEmailCode() {},
      async login(input: { email: string; code: string }) {
        return { identity: { provider: "shared-auth", subject: input.email, email: input.email } };
      },
    }),
  };
  const secondFactory = {
    id: "shared-auth",
    scope: "platform" as const,
    create: firstFactory.create,
  };
  const registry = new PlatformPluginRegistry([
    plugin("first", {
      manifest: { ...plugin("first").manifest, authProviders: ["shared-auth"] },
      authProviders: [firstFactory],
    }),
    plugin("second", {
      manifest: { ...plugin("second").manifest, authProviders: ["shared-auth"] },
      authProviders: [secondFactory],
    }),
  ]);

  assert.deepEqual(registry.authProviderIds(), ["shared-auth"]);
  const providers = registry.createAuthProviderRegistry();
  assert.deepEqual(providers.providerIds(), ["shared-auth"]);
  assert.equal(providers.has("SHARED-AUTH"), true);
});

test("platform registry exposes an immutable legacy island owned by its App", () => {
  const provider = {
    id: "legacy-auth",
    scope: "platform" as const,
    create: () => ({
      provider: "legacy-auth",
      async sendEmailCode() {},
      async login(input: { email: string; code: string }) {
        return { identity: { provider: "legacy-auth", subject: input.email, email: input.email } };
      },
    }),
  };
  const routes = { auth: ["/legacy/email-codes", "/legacy/login"] } as const;
  const registry = new PlatformPluginRegistry([plugin("legacy-app", {
    manifest: {
      ...plugin("legacy-app").manifest,
      authProviders: ["legacy-auth"],
      executionContracts: ["none"],
    },
    authProviders: [provider],
    legacy: {
      routes,
      auth: { providerId: "legacy-auth", routeAliases: routes },
      migration: {
        plan: {
          id: "legacy-app-v1",
          fromSchema: "legacy-v0",
          toSchema: "openapp-v1",
          checksum: "a".repeat(64),
          strategy: "additive",
          preserves: ["users", "workspaces"],
        },
      },
    },
  })]);
  assert.deepEqual(registry.legacyRouteAliasesForApp("LEGACY-APP"), routes);
  const copy = registry.legacyForApp("legacy-app")!;
  assert.throws(() => {
    (copy.migration!.plan.preserves as string[])[0] = "audit";
  }, TypeError);
  assert.deepEqual(registry.legacyMigrationForApp("legacy-app")?.plan.preserves, ["users", "workspaces"]);
});

test("platform registry rejects a legacy Provider that is not registered for the App", () => {
  const routes = { auth: ["/legacy/login"] } as const;
  assert.throws(
    () => new PlatformPluginRegistry([plugin("legacy-app", {
      manifest: { ...plugin("legacy-app").manifest, authProviders: ["other-auth"] },
      legacy: { routes, auth: { providerId: "legacy-auth", routeAliases: routes } },
    })]),
    /platform_plugin_legacy_auth_provider_mismatch/u,
  );
});

test("platform registry rejects legacy behavior that is not tied to registered auth owners", () => {
  const routes = { auth: ["/legacy/login"] } as const;
  const provider = {
    id: "legacy-auth",
    async sendEmailCode() {},
    async login(input: { email: string; code: string }) {
      return { identity: { provider: "legacy-auth", subject: input.email, email: input.email } };
    },
  };
  assert.throws(
    () => new PlatformPluginRegistry([plugin("legacy-app", {
      manifest: { ...plugin("legacy-app").manifest, authProviders: ["legacy-auth"] },
      legacy: { routes, auth: { provider: provider as AdapterAuthProvider, routeAliases: routes } },
    })]),
    /platform_plugin_legacy_auth_provider_missing/u,
  );

  const registeredHandoff = {
    appId: "legacy-app",
    managedCookieNames: ["legacy_session"],
    async onLogin() { return []; },
    async onLogout() { return []; },
    proxyOptions() { return {}; },
  };
  assert.throws(
    () => new PlatformPluginRegistry([plugin("legacy-app", {
      authHandoff: registeredHandoff,
      legacy: {
        auth: {
          handoff: {
            ...registeredHandoff,
            managedCookieNames: ["different_session"],
          },
        },
      },
    })]),
    /platform_plugin_legacy_auth_cookie_mismatch/u,
  );
});
