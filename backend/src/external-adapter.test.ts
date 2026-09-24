import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertExternalAppAdapter, loadExternalAppAdapter, normalizeAdapterEmailCodeResult } from "./external-adapter.js";
import type { OciArtifactManagementPort } from "./artifact-provider.js";
import { PlatformPluginRegistry } from "./platform-plugins.js";
import {
  validateAdapterCompatibility,
  type AdapterAuthHandoff,
  type AdapterAuthProvider,
  type AdapterProxyOptions,
  type OpenAppAdapter,
} from "@openapp/contracts";

const digest = `sha256:${"a".repeat(64)}`;

test("v1 adapters are rejected before registration in the v2 host", () => {
  const { adapter } = credentialedLegacyAdapter();
  assert.throws(() => convertExternalAppAdapter({ ...adapter, manifest: { ...adapter.manifest, apiVersion: "v1" } }, { artifacts: inertArtifacts() }), /api_version/);
});

test("adapter auth errors preserve validated public status and reject unsafe mappings", async () => {
  const { adapter, provider } = credentialedLegacyAdapter();
  let mapping = { status: 403, code: 'enrollment_required' };
  provider.mapError = () => mapping;
  provider.login = async () => { throw new Error('upstream private details'); };
  provider.sendEmailCode = async () => { throw new Error('upstream private details'); };
  const plugin = convertExternalAppAdapter(adapter, { artifacts: inertArtifacts() });
  const service = new PlatformPluginRegistry([plugin]).createAuthService(provider.id)!;
  const { mapGenericProviderError } = await import('./auth/provider-compatibility.js');
  await assert.rejects(service.login({ email: 'user@example.test', code: '123456' }), error => {
    assert.deepEqual(mapGenericProviderError(error, 'login'), mapping);
    assert.equal(String(error).includes('private details'), false);
    return true;
  });
  mapping = { status: 200, code: 'bad_status' };
  await assert.rejects(service.sendEmailCode('user@example.test'), /external_adapter_auth_error_mapping_invalid/);
  mapping = { status: 400, code: 'private details\nsecret' };
  await assert.rejects(service.login({ email: 'user@example.test', code: '123456' }), /external_adapter_auth_error_mapping_invalid/);
});

test("external adapter converts auth, handoff, catalog and build contracts", async () => {
  const calls: Array<Record<string, unknown> | undefined> = [];
  const adapter: OpenAppAdapter = {
    buildStrategy: { id: "story-build", revision: 1, async execute() { throw new Error("test build not invoked"); } },
    manifest: {
      id: "story-app",
      apiVersion: "v2",
      version: "1.0.0",
      name: "Story App",
      description: "A generic app",
      entry: {
        id: "story-entry",
        label: "Story App",
        logoUrl: "/story.png",
        challenge: "email_code",
        defaultWorkspace: "personal",
      },
      capabilities: { websocket: true },
      auth: {
        providerId: "story-auth",
        protocol: "email_code",
        fields: [],
      },
      workload: {
        runtimeContract: "story-v1",
        environmentKind: "container",
        workloadClass: "web",
        accessMode: "http",
        healthPath: "/health",
      },
      build: {
        strategyId: "story-build",
        revision: 1,
        runtimeContract: "story-v1",
        imagePrefix: "story",
        packageRequirements: [{ key: "backend", required: true, acceptedExtensions: [".tgz"] }],
      },
      catalogBootstrap: {
        version: "1.0.0",
        imageReference: "story-runtime:1",
        runtimeContract: "story-v1",
      },
    },
    authProvider: {
      id: "story-auth",
      presentation: { label: "Story", iconUrl: "/story.png", challenge: "email_code" },
      async sendEmailCode() {
        return {
          requiresOrganization: true,
          requires_plan: true,
          isNewUser: true,
          nested: { privateToken: "do-not-leak" },
          accessToken: "do-not-leak",
        };
      },
      async login(input) {
        calls.push(input.providerData as Record<string, unknown> | undefined);
        return {
          identity: { provider: "story-auth", subject: "subject-1", email: input.email },
          credentialGrant: { kind: "story-grant", provider: "story-auth", value: "opaque" },
        };
      },
    },
    authHandoff: {
      appId: "story-app",
      managedCookieNames: ["story_session"],
      async onLogin() { return ["story_session=ok; Path=/"] as const; },
      async onLogout() { return ["story_session=; Max-Age=0; Path=/"] as const; },
      proxyOptions() { return { rootScopedCookieNames: ["story_session"] }; },
      acceptsCredentialGrant(grant) { return grant.provider === "story-auth"; },
    },
    buildProfile: undefined,
  };
  const plugin = convertExternalAppAdapter(adapter, { artifacts: inertArtifacts() });
  assert.equal(plugin.appId, "story-app");
  assert.deepEqual(plugin.manifest.executionContracts, ["story-v1"]);
  assert.equal(plugin.catalogBootstrap?.app.authAdapterId, "story-app");
  assert.equal(plugin.strategyDefinitions?.[0]?.id, "story-build");
  assert.equal(plugin.buildStrategies?.[0]?.revision, 1);
  assert.equal(plugin.buildStrategies?.[0], adapter.buildStrategy, 'Core must use the Adapter implementation without substituting a built-in recipe');
  assert.throws(() => convertExternalAppAdapter({ ...adapter, buildStrategy: { ...adapter.buildStrategy!, revision: 2 } }, {
    artifacts: inertArtifacts(),
  }), /external_adapter_build_implementation_mismatch/);
  const registry = new PlatformPluginRegistry([plugin]);
  const auth = registry.createAuthService("story-auth")!;
  assert.deepEqual(await auth.sendEmailCode("user@example.com"), {
    providerData: { requiresOrganization: true, requires_plan: true },
    isNewUser: true,
  });
  const result = await auth.login({ email: "user@example.com", code: "123456", providerData: { organizationKey: "JOIN" } });
  assert.equal(result.identity.provider, "story-auth");
  assert.deepEqual(calls, [{ organizationKey: "JOIN" }]);
  const handoff = plugin.authHandoff!;
  assert.deepEqual(await handoff.onLogin({
    sessionId: "session-1",
    secureCookies: false,
    credentialGrant: result.credentialGrant,
  }), ["story_session=ok; Path=/"]);
});

test("external adapter challenge normalization keeps opaque scalar metadata only", () => {
  assert.deepEqual(normalizeAdapterEmailCodeResult({
    providerData: {
      regionHint: "test-region",
      nested: { shouldDrop: true },
      refreshToken: "should-drop",
    },
    requiresOrganization: false,
    finite: 3,
    infinite: Number.POSITIVE_INFINITY,
    callback: () => "should-drop",
    isNewUser: false,
  }), {
    providerData: { regionHint: "test-region", requiresOrganization: false, finite: 3 },
    isNewUser: false,
  });
  assert.deepEqual(normalizeAdapterEmailCodeResult(undefined), {});
  assert.throws(
    () => normalizeAdapterEmailCodeResult("invalid"),
    /external_adapter_auth_challenge_invalid/u,
  );
});

test("external adapter accepts a neutral App without auth, handoff, or build code", () => {
  const plugin = convertExternalAppAdapter(neutralAdapter(), { artifacts: inertArtifacts() });
  assert.equal(plugin.appId, "notes-app");
  assert.equal(plugin.authProviders, undefined);
  assert.equal(plugin.authHandoff, undefined);
  assert.equal(plugin.buildStrategies, undefined);
  assert.deepEqual(plugin.manifest.authProviders, []);
  assert.deepEqual(plugin.manifest.buildStrategies, []);
  assert.equal(plugin.manifest.executionContracts?.[0], "notes-v1");

  const registry = new PlatformPluginRegistry([plugin]);
  assert.deepEqual(registry.authProviderIdsForApp("notes-app"), []);
  assert.equal(registry.supportsCredentialedApp("notes-app"), false);
  assert.deepEqual(registry.workspaceEntryManifest("notes-app"), {
    appId: "notes-app",
    appName: "Notes App",
    entry: {
      id: "notes-entry",
      label: "Notes App",
      logoUrl: "https://cdn.example.test/notes.png",
      challenge: "none",
      defaultWorkspace: "personal",
    },
    capabilities: { websocket: false },
  });
});

test("external adapter bridges compatibility metadata without exposing mutable state", () => {
  const adapter = neutralAdapter("compat-app");
  const compatibility = {
    legacyAliases: {
      appIds: ["old-notes"],
      providerIds: ["old-sso"],
      environmentKeys: ["OLD_NOTES_URL"],
      cookieNames: ["old_notes_session"],
      routeAliases: ["/old-notes"],
    },
    errorCatalog: {
      en: { old_runtime_error: "The old runtime is unavailable." },
      "zh-CN": { old_runtime_error: "旧运行时暂不可用。" },
    },
  } as const;
  const plugin = convertExternalAppAdapter({ ...adapter, compatibility: { ...compatibility } }, { artifacts: inertArtifacts() });
  assert.deepEqual(plugin.compatibility, compatibility);
  const registry = new PlatformPluginRegistry([plugin]);
  const first = registry.compatibilityForApp("compat-app");
  assert.deepEqual(first, compatibility);
  assert.throws(() => {
    (first!.legacyAliases!.appIds as unknown as string[])[0] = "mutated";
  }, TypeError);
  assert.throws(() => {
    (first!.errorCatalog!.en as unknown as Record<string, string>).old_runtime_error = "mutated";
  }, TypeError);
  assert.equal(registry.migrationPlanForApp("compat-app"), undefined);
  assert.deepEqual(registry.compatibilityForApp("compat-app"), compatibility);
  assert.deepEqual(registry.workspaceEntryManifest("compat-app")?.errorCatalog, compatibility.errorCatalog);
});

test("external adapter rejects divergent compatibility declarations", () => {
  const adapter = neutralAdapter("compat-mismatch");
  assert.throws(
    () => convertExternalAppAdapter({
      ...adapter,
      manifest: {
        ...adapter.manifest,
        compatibility: { errorCatalog: { en: { old_error: "manifest" } } },
      },
      compatibility: { errorCatalog: { en: { old_error: "adapter" } } },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_compatibility_mismatch/u,
  );
});

test("public compatibility contract rejects unsafe aliases and migration descriptors", () => {
  assert.throws(
    () => validateAdapterCompatibility({
      legacyAliases: { routeAliases: ["/../control"] },
    }),
    /adapter_manifest_compatibility_route_alias_invalid/u,
  );
  assert.throws(
    () => validateAdapterCompatibility({
      errorCatalog: { en: { access_token: "must not be accepted" } },
    }),
    /adapter_manifest_compatibility_error_key_invalid/u,
  );
  assert.throws(
    () => validateAdapterCompatibility({
      migration: {
        id: "notes-migration",
        fromSchema: "legacy-v1",
        toSchema: "openapp-v1",
        checksum: "not-a-sha256",
        strategy: "transform",
      },
    }),
    /adapter_manifest_compatibility_migration_checksum_invalid/u,
  );
  const plan = validateAdapterCompatibility({
    migration: {
      id: "notes-migration",
      fromSchema: "legacy-v1",
      toSchema: "openapp-v1",
      checksum: "sha256:" + "a".repeat(64),
      strategy: "transform",
      preserves: ["users", "workspaces", "audit"],
    },
  });
  assert.equal(plan.migration?.checksum, "sha256:" + "a".repeat(64));
});

test("public compatibility contract rejects empty and semantically duplicate diagnostics", () => {
  assert.throws(
    () => validateAdapterCompatibility({ errorCatalog: {} }),
    /adapter_manifest_compatibility_error_catalog_invalid/u,
  );
  assert.throws(
    () => validateAdapterCompatibility({ errorCatalog: { en: {} } }),
    /adapter_manifest_compatibility_error_catalog_invalid/u,
  );
  assert.throws(
    () => validateAdapterCompatibility({
      errorCatalog: {
        en: { runtime_error: "English" },
        EN: { runtime_error: "Duplicate locale" },
      },
    }),
    /adapter_manifest_compatibility_error_locale_duplicate/u,
  );
  assert.throws(
    () => validateAdapterCompatibility({
      errorCatalog: { en: { Runtime_Error: "one", runtime_error: "two" } },
    }),
    /adapter_manifest_compatibility_error_key_duplicate/u,
  );
  assert.throws(
    () => validateAdapterCompatibility({
      errorCatalog: { en: { runtime_error: "   " } },
    }),
    /adapter_manifest_compatibility_error_value_invalid/u,
  );
});

test("compatibility migration checksums accept bare and prefixed SHA-256 forms", () => {
  const bare = validateAdapterCompatibility({
    migration: {
      id: "bare-checksum",
      fromSchema: "legacy-v1",
      toSchema: "openapp-v1",
      checksum: "A".repeat(64),
      strategy: "additive",
    },
  });
  const prefixed = validateAdapterCompatibility({
    migration: {
      id: "prefixed-checksum",
      fromSchema: "legacy-v1",
      toSchema: "openapp-v1",
      checksum: "sha256:" + "B".repeat(64),
      strategy: "additive",
    },
  });
  assert.equal(bare.migration?.checksum, "a".repeat(64));
  assert.equal(prefixed.migration?.checksum, "sha256:" + "b".repeat(64));
});

test("compatibility lookup normalizes App IDs at the registry boundary", () => {
  const adapter = neutralAdapter("compat-case");
  const plugin = convertExternalAppAdapter({
    ...adapter,
    compatibility: { errorCatalog: { en: { runtime_error: "Unavailable" } } },
  }, { artifacts: inertArtifacts() });
  const registry = new PlatformPluginRegistry([plugin]);
  assert.deepEqual(registry.compatibilityForApp("  COMPAT-CASE  ")?.errorCatalog, {
    en: { runtime_error: "Unavailable" },
  });
});

test("external adapter does not infer Sample App behavior from an App id", () => {
  const adapter = neutralAdapter("sample-app");
  const plugin = convertExternalAppAdapter(adapter, { artifacts: inertArtifacts() });
  assert.equal(plugin.appId, "sample-app");
  assert.deepEqual(plugin.manifest.authProviders, []);
  assert.equal(plugin.authHandoff, undefined);
  assert.equal(plugin.authProviders, undefined);
  assert.equal(plugin.catalogBootstrap, undefined);
});

test("external adapter fails closed when auth is declared without a Provider", () => {
  const adapter = neutralAdapter();
  assert.throws(
    () => convertExternalAppAdapter({
      ...adapter,
      manifest: {
        ...adapter.manifest,
        entry: { ...adapter.manifest.entry, challenge: "email_code" },
        auth: { providerId: "notes-auth", protocol: "email_code", fields: [] },
      },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_auth_provider_missing/u,
  );
});

test("external adapter rejects unsafe or inconsistent contracts", () => {
  const base: OpenAppAdapter = {
    manifest: {
      id: "story-app",
      apiVersion: "v2",
      version: "1.0.0",
      name: "Story",
      description: "",
      entry: { id: "story", label: "Story", logoUrl: "/story.png", challenge: "email_code", defaultWorkspace: "personal" },
      capabilities: {},
      workload: { runtimeContract: "story-v1", environmentKind: "container", workloadClass: "web", accessMode: "http", healthPath: "/health" },
      auth: { providerId: "story-auth", protocol: "email_code", fields: [] },
    },
    authProvider: { id: "different", async sendEmailCode() {}, async login() { return { identity: { provider: "different", subject: "s", email: "s@example.com" } }; } },
  };
  assert.throws(
    () => convertExternalAppAdapter(base, { artifacts: inertArtifacts() }),
    /external_adapter_auth_provider_mismatch/,
  );
  assert.throws(
    () => convertExternalAppAdapter({
      ...base,
      manifest: {
        ...base.manifest,
        entry: { ...base.manifest.entry, challenge: "oidc" },
        auth: { providerId: "story-auth", protocol: "oidc", fields: [] },
      },
      authProvider: {
        id: "story-auth",
        async sendEmailCode() {},
        async login() {
          return { identity: { provider: "story-auth", subject: "s", email: "s@example.com" } };
        },
      },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_entry_challenge_unsupported/,
  );
});

test("external adapter fails closed when a legacy island crosses App identity", () => {
  const adapter = neutralAdapter("legacy-app");
  const routes = { auth: ["/legacy/email-codes"] } as const;
  assert.throws(
    () => convertExternalAppAdapter({
      ...adapter,
      legacy: {
        routes,
        auth: { providerId: "other-app", routeAliases: routes },
        catalog: { appId: "other-app" },
      },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_legacy_catalog_app_mismatch/u,
  );
});

test("external adapter fails closed when a legacy island has no normal auth owner", () => {
  const adapter = neutralAdapter("legacy-auth");
  const routes = { auth: ["/legacy/login"] } as const;
  assert.throws(
    () => convertExternalAppAdapter({
      ...adapter,
      legacy: {
        routes,
        auth: { providerId: "legacy-sso", routeAliases: routes },
      },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_legacy_auth_provider_missing/u,
  );
});

test("external adapter requires legacy auth to reuse the normal Provider and handoff instances", () => {
  const { adapter, provider, handoff } = credentialedLegacyAdapter();
  const routes = { auth: ["/legacy/login"] } as const;
  assert.throws(
    () => convertExternalAppAdapter({
      ...adapter,
      legacy: {
        routes,
        auth: { providerId: "legacy-auth", provider: { ...provider }, routeAliases: routes },
      },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_legacy_auth_provider_mismatch/u,
  );
  assert.throws(
    () => convertExternalAppAdapter({
      ...adapter,
      legacy: {
        routes,
        auth: { providerId: "legacy-auth", handoff: { ...handoff }, routeAliases: routes },
      },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_legacy_handoff_mismatch/u,
  );
});

test("external adapter rejects legacy catalog metadata with a different runtime contract", () => {
  const adapter = neutralAdapter("legacy-catalog");
  assert.throws(
    () => convertExternalAppAdapter({
      ...adapter,
      legacy: {
        catalog: {
          appId: "legacy-catalog",
          bootstrap: {
            version: "1.0.0",
            imageReference: "legacy:1",
            runtimeContract: "other-runtime",
          },
        },
      },
    }, { artifacts: inertArtifacts() }),
    /external_adapter_legacy_runtime_contract_mismatch/u,
  );
});

test("external adapter enforces module allowlists and proxy response boundaries", async (t) => {
  const baseAdapter = loadedAdapterWithProxy(() => ({ upstreamHeaders: { "x-test": "ok\r\nInjected: yes" } }));
  const plugin = convertExternalAppAdapter(baseAdapter, { artifacts: inertArtifacts() });
  assert.throws(
    () => plugin.authHandoff!.proxyOptions({ instanceId: "instance-1", secureCookies: false }),
    /external_adapter_proxy_options_invalid/,
  );
  const valid = convertExternalAppAdapter(
    loadedAdapterWithProxy(() => ({ upstreamHost: "workspace.provider.internal:8443", upstreamHeaders: { "x-test": "ok" } })),
    { artifacts: inertArtifacts() },
  );
  assert.deepEqual(valid.authHandoff!.proxyOptions({ instanceId: "instance-1", secureCookies: true }), {
    upstreamHost: "workspace.provider.internal:8443",
    upstreamHeaders: { "x-test": "ok" },
    secureRootScopedCookies: true,
  });
});

test("external adapter rejects a module symlink that escapes its approved root", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "openapp-adapter-symlink-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const approvedRoot = join(fixtureRoot, "approved");
  const externalRoot = join(fixtureRoot, "external");
  await Promise.all([
    mkdir(approvedRoot, { recursive: true }),
    mkdir(externalRoot, { recursive: true }),
  ]);
  const externalModule = join(externalRoot, "adapter.mjs");
  const linkedModule = join(approvedRoot, "adapter.mjs");
  await writeFile(externalModule, "export default () => ({});\n", "utf8");
  await symlink(externalModule, linkedModule);

  await assert.rejects(
    loadExternalAppAdapter({
      moduleSpecifier: linkedModule,
      approvedModuleRoots: [approvedRoot],
      artifacts: inertArtifacts(),
    }),
    /external_adapter_module_not_approved/,
  );
});

function loadedAdapterWithProxy(proxyOptions: () => Readonly<AdapterProxyOptions>): OpenAppAdapter {
  return {
    manifest: {
      id: "proxy-app",
      apiVersion: "v2",
      version: "1.0.0",
      name: "Proxy App",
      description: "",
      entry: { id: "proxy", label: "Proxy App", logoUrl: "/proxy.png", challenge: "none", defaultWorkspace: "personal" },
      capabilities: {},
      auth: { providerId: "proxy-none", protocol: "none", fields: [] },
      workload: { runtimeContract: "proxy-v1", environmentKind: "container", workloadClass: "web", accessMode: "http", healthPath: "/health" },
    },
    authHandoff: {
      appId: "proxy-app",
      managedCookieNames: ["proxy_session"],
      async onLogin() { return []; },
      async onLogout() { return []; },
      proxyOptions,
    },
  };
}

function neutralAdapter(id = "notes-app"): OpenAppAdapter {
  return {
    manifest: {
      id,
      apiVersion: "v2",
      version: "1.0.0",
      name: "Notes App",
      description: "A regular Web application.",
      entry: {
        id: "notes-entry",
        label: "Notes App",
        logoUrl: "https://cdn.example.test/notes.png",
        challenge: "none",
        defaultWorkspace: "personal",
      },
      capabilities: { websocket: false },
      workload: {
        runtimeContract: "notes-v1",
        environmentKind: "container",
        workloadClass: "web",
        accessMode: "http",
        healthPath: "/health",
      },
    },
  };
}

function credentialedLegacyAdapter(): {
  adapter: OpenAppAdapter;
  provider: AdapterAuthProvider;
  handoff: AdapterAuthHandoff;
} {
  const provider: AdapterAuthProvider = {
    id: "legacy-auth",
    async sendEmailCode() {},
    async login(input) {
      return { identity: { provider: "legacy-auth", subject: input.email, email: input.email } };
    },
  };
  const handoff: AdapterAuthHandoff = {
    appId: "legacy-catalog",
    managedCookieNames: ["legacy_session"],
    async onLogin() { return []; },
    async onLogout() { return []; },
    proxyOptions() { return {}; },
  };
  return {
    provider,
    handoff,
    adapter: {
      manifest: {
        id: "legacy-catalog",
        apiVersion: "v2",
        version: "1.0.0",
        name: "Legacy Catalog",
        description: "",
        entry: {
          id: "legacy-catalog",
          label: "Legacy Catalog",
          logoUrl: "https://example.test/legacy.png",
          challenge: "email_code",
          defaultWorkspace: "personal",
        },
        capabilities: {},
        auth: { providerId: "legacy-auth", protocol: "email_code", fields: [] },
        workload: {
          runtimeContract: "legacy-runtime",
          environmentKind: "container",
          workloadClass: "web",
          accessMode: "http",
          healthPath: "/health",
        },
      },
      authProvider: provider,
      authHandoff: handoff,
    },
  };
}

function inertArtifacts(): OciArtifactManagementPort {
  return {
    async listImages() { return []; },
    async resolveImage() { return digest; },
    async validateImage() {},
    async validateBuiltImage() {},
    async removeImageIfCurrent() { return true; },
    async pullImage() {},
    async loadImage() {},
  };
}
