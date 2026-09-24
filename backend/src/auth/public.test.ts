import assert from "node:assert/strict";
import test from "node:test";
import * as authPublic from "./public.js";

test("generic auth public entry does not expose legacy Provider implementations", () => {
  assert.deepEqual(Object.keys(authPublic).sort(), ['AuthProviderRegistry', 'createGenericAuthService']);
  assert.equal(typeof authPublic.createGenericAuthService, "function");
  assert.equal(typeof authPublic.AuthProviderRegistry, "function");
});

test("unregistered providers cannot enable mock authentication", () => {
  assert.throws(() => authPublic.createGenericAuthService({ authProvider: "mock" }), /auth_provider_not_registered/u);
});

test("generic auth public entry keeps an explicit no-auth service fail-closed", async () => {
  const service = authPublic.createGenericAuthService({ authProvider: "none" });
  assert.equal(service.provider, "none");
  await assert.rejects(service.sendEmailCode("person@example.com"), /auth_provider_not_configured/u);
});
