import assert from "node:assert/strict";
import test from "node:test";
import type { ProxyOptions } from "../proxy.js";
import {
  AppAuthHandoffCoordinator,
  AppAuthHandoffError,
  AppAuthHandoffRegistry,
  type AppAuthHandoff,
} from "./app-auth-handoff.js";
import type { AuthCredentialGrant } from "./types.js";

const grant = {
  kind: "sample-token-pair",
  provider: "sample-auth",
  issuer: "https://identity.example.test",
  accessToken: "access",
  accessTokenExpiresIn: 3_600,
  refreshToken: "refresh",
  refreshTokenExpiresIn: 86_400,
  tokenType: "Bearer",
} satisfies AuthCredentialGrant;

test("registry rejects duplicate App ids at startup", () => {
  assert.throws(
    () => registry([handoff("Sample-App", ["sample_auth"]), handoff("sample-app", ["other_auth"])]),
    errorCode("app_auth_handoff_duplicate_app_id"),
  );
});

test("registry permits a generic platform with no credentialed App handoffs", async () => {
  const coordinator = new AppAuthHandoffCoordinator(registry([]), {
    defaultAppId: "plain-web",
    resolveNoAuthApp: async (appId) => appId === "plain-web",
  });

  assert.deepEqual(coordinator.listApps(), []);
  assert.equal(await coordinator.supportsAppAsync("plain-web"), true);
  assert.equal(await coordinator.resolveAppIdForUser("user-1"), "plain-web");
  assert.deepEqual(await coordinator.onLogoutAll({ secureCookies: false }), []);
  assert.deepEqual(await coordinator.proxyOptionsAsync("plain-web", {
    instanceId: "instance-1",
    secureCookies: false,
  }), {
    secureRootScopedCookies: false,
    stripCookieNames: ["portal_session"],
    stripResponseCookieNames: ["portal_session"],
  });
});

test("registry rejects duplicate and Portal-conflicting cookie names at startup", () => {
  assert.throws(
    () => registry([handoff("app-a", ["shared_auth"]), handoff("app-b", ["SHARED_AUTH"])]),
    errorCode("app_auth_handoff_duplicate_cookie_name"),
  );
  assert.throws(
    () => registry([handoff("app-a", ["one_auth", "ONE_AUTH"])]),
    errorCode("app_auth_handoff_duplicate_cookie_name"),
  );
  assert.throws(
    () => registry([handoff("app-a", ["Portal_Session"])]),
    errorCode("app_auth_handoff_portal_cookie_conflict"),
  );
});

test("known App proxy allows only its handoff cookies", () => {
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("app-a", ["app_a_auth"], { rootScopedCookieNames: ["app_a_auth"] }),
    handoff("app-b", ["app_b_auth"]),
  ]));

  assert.deepEqual(coordinator.proxyOptions("app-a", { instanceId: "instance-1", secureCookies: true }), {
    rootScopedCookieNames: ["app_a_auth"],
    secureRootScopedCookies: true,
    stripCookieNames: ["portal_session", "app_b_auth"],
    stripResponseCookieNames: ["portal_session", "app_b_auth"],
  });
});

test("proxy cannot allow an undeclared root cookie or weaken HTTPS", () => {
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("app-a", ["app_a_auth"], {
      rootScopedCookieNames: ["unmanaged_auth"],
      secureRootScopedCookies: false,
    }),
  ]));
  assert.throws(
    () => coordinator.proxyOptions("app-a", { instanceId: "instance-1", secureCookies: true }),
    errorCode("app_auth_handoff_unmanaged_root_cookie"),
  );
  const secure = new AppAuthHandoffCoordinator(registry([
    handoff("app-a", ["app_a_auth"], {
      rootScopedCookieNames: ["app_a_auth"],
      secureRootScopedCookies: false,
    }),
  ])).proxyOptions("app-a", { instanceId: "instance-1", secureCookies: true });
  assert.equal(secure.secureRootScopedCookies, true);
});

test("unknown App proxy fails closed before a request can reach an instance", async () => {
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("app-a", ["app_a_auth"]),
    handoff("app-b", ["app_b_auth"]),
  ]));

  assert.throws(
    () => coordinator.proxyOptions("unregistered-app", {
      instanceId: "instance-1",
      secureCookies: false,
    }),
    errorCode("app_auth_handoff_not_registered"),
  );
  await assert.rejects(
    coordinator.onLogin("unregistered-app", loginInput()),
    errorCode("app_auth_handoff_not_registered"),
  );
});

test("logout continues across adapters and emits a conservative fallback on adapter failure", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const failing = handoff("app-a", ["app_a_auth"]);
  failing.onLogout = async () => { throw new Error("unavailable"); };
  const healthy = handoff("app-b", ["app_b_auth"]);
  healthy.onLogout = async () => ["app_b_auth=; Path=/; Max-Age=0; SameSite=Lax"];
  const cookies = await new AppAuthHandoffCoordinator(registry([failing, healthy])).onLogoutAll({
    secureCookies: false,
  });
  assert.deepEqual(cookies, [
    "app_a_auth=; Path=/; Max-Age=0; SameSite=Lax",
    "app_b_auth=; Path=/; Max-Age=0; SameSite=Lax",
  ]);
});

test("provider grants select their reviewed App independently of the default catalog App", async () => {
  const calls: Array<[string, boolean]> = [];
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("sample-app", [], undefined, calls, true),
    handoff("other", [], undefined, calls),
  ]), {
    defaultAppId: "sample-app",
    resolveAppId: async (userId) => userId === "existing-user" ? "other" : null,
  });

  assert.equal(await coordinator.resolveAppIdForUser("new-user"), "sample-app");
  assert.equal(await coordinator.resolveAppIdForUser("existing-user"), "other");
  await coordinator.onLoginForUser("new-user", loginInput(grant));
  const revoked: string[] = [];
  await assert.rejects(
    coordinator.onLoginForUser("existing-user", {
      ...loginInput(grant),
      async revokeRefreshSession(token) { revoked.push(token); },
    }),
    errorCode("app_auth_credential_app_mismatch"),
  );
  assert.deepEqual(calls, [
    ["other", false],
    ["sample-app", true],
  ]);
  assert.deepEqual(revoked, ["refresh"]);
});

test("App resolution normalizes identifiers before grant matching", async () => {
  const calls: Array<[string, boolean]> = [];
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("sample-app", [], undefined, calls, true),
  ]), {
    defaultAppId: "sample-app",
    resolveAppId: async () => " Sample-App ",
  });

  assert.equal(await coordinator.resolveAppIdForUser("user-1"), "sample-app");
  await coordinator.onLoginForUser("user-1", loginInput(grant));
  assert.deepEqual(calls, [["sample-app", true]]);
});

test("durable no-auth Apps resolve across coordinator processes", async () => {
  let available = false;
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("sample-app", ["sample-app_auth"], undefined, undefined, true),
  ]), {
    resolveAppId: async () => "story-app",
    resolveNoAuthApp: async (appId) => available && appId === "story-app",
  });

  assert.equal(coordinator.supportsCredentialedApp("story-app"), false);
  assert.equal(await coordinator.supportsAppAsync("story-app"), false);
  available = true;
  assert.equal(await coordinator.supportsAppAsync("story-app"), true);
  const revoked: string[] = [];
  await coordinator.onLoginForUser("user-1", {
    ...loginInput(grant),
    async revokeRefreshSession(token) { revoked.push(token); },
  });
  assert.deepEqual(revoked, []);
  assert.deepEqual(await coordinator.proxyOptionsAsync("story-app", {
    instanceId: "instance-1",
    secureCookies: false,
  }), {
    secureRootScopedCookies: false,
    stripCookieNames: ["portal_session", "sample-app_auth"],
    stripResponseCookieNames: ["portal_session", "sample-app_auth"],
  });
});

test("App resolution failure is preserved for local login", async () => {
  const revoked: Array<[string, string]> = [];
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("sample-app", ["sample-app_auth"]),
  ]), {
    resolveAppId: async () => { throw new Error("database unavailable"); },
  });

  await assert.rejects(
    coordinator.onLoginForUser("user-1", {
      ...loginInput(),
    }),
    /database unavailable/u,
  );
  assert.deepEqual(revoked, []);
});

test("an unclaimed provider grant is revoked instead of reaching a no-auth App", async () => {
  const revoked: Array<[string, string]> = [];
  const coordinator = new AppAuthHandoffCoordinator(registry([
    handoff("sample-app", ["sample-app_auth"]),
  ]));

  await assert.rejects(
    coordinator.onLoginForUser("user-1", {
      ...loginInput(grant),
      async revokeRefreshSession(token, reason) { revoked.push([token, reason]); },
    }),
    errorCode("app_auth_credential_consumer_missing"),
  );
  assert.deepEqual(revoked, [["refresh", "materialize_failed"]]);
});

function registry(handoffs: readonly AppAuthHandoff[]): AppAuthHandoffRegistry {
  return new AppAuthHandoffRegistry({ portalCookieName: "portal_session", handoffs });
}

function handoff(
  appId: string,
  managedCookieNames: readonly string[],
  options: ProxyOptions = {},
  calls?: Array<[string, boolean]>,
  acceptsGrant = false,
): AppAuthHandoff {
  return {
    appId,
    managedCookieNames,
    ...(acceptsGrant ? { acceptsCredentialGrant: () => true } : {}),
    async onLogin(input) {
      calls?.push([appId, Boolean(input.credentialGrant)]);
      return [];
    },
    async onLogout() { return []; },
    proxyOptions() { return options; },
  };
}

function loginInput(credentialGrant?: typeof grant) {
  return {
    sessionId: "session",
    secureCookies: false,
    ...(credentialGrant ? { credentialGrant } : {}),
  } as const;
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof AppAuthHandoffError && error.code === code;
}
