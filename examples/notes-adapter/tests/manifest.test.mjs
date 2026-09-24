/** 独立 SDK 验证真实工厂，并确认应用不会接收平台 Cookie 或外部凭证。 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateAdapterManifest } from "@openapp/contracts";
import createAdapter from "../dist/index.js";
test("existing image, local login and credential-free application contract", async () => {
  const adapter = createAdapter();
  validateAdapterManifest(adapter.manifest);
  assert.equal(adapter.manifest.workload.runtime.containerPort, 8080);
  assert.equal(adapter.manifest.build, undefined);
  assert.equal(adapter.manifest.catalogBootstrap.imageReference, "openapp-notes-demo:1.0.0");
  assert.deepEqual(adapter.authHandoff.proxyOptions(), { stripRequestCookies: true });
  assert.equal(adapter.authHandoff.acceptsCredentialGrant({}), false);
  await assert.rejects(
    adapter.authHandoff.onLogin({ credentialGrant: {} }),
    /credential_grant_not_supported/,
  );
});
