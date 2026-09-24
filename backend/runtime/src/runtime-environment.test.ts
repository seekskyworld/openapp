import assert from "node:assert/strict";
import test from "node:test";
import { isRuntimeReservedEnvironmentName, runtimeReservedEnvironmentNames } from "./runtime-environment.js";
import { GENERIC_RUNTIME_PROFILE } from "./runtime-profile.js";

test("application suffixes are not globally reserved", () => {
  for (const name of ["DATA_DIR", "APP_DATA_DIR", "STATE_PATH", "APP_STATE_LOCK_RECOVERY_ID", "APP_BRIDGE_SETTINGS_PATH"]) {
    assert.equal(isRuntimeReservedEnvironmentName(name), false, name);
  }
  assert.equal(isRuntimeReservedEnvironmentName("OPENAPP_CONFIG_FILES_JSON"), true);
});

test("the selected profile protects exact declared and injected names", () => {
  const additionalReserved = runtimeReservedEnvironmentNames({
    ...GENERIC_RUNTIME_PROFILE,
    reservedEnvironment: ["APP_DATA_DIR"],
    configEnvironmentKey: "APP_CONFIG",
    recoveryCommand: ["/bin/recover"],
    lockRecoveryEnvironment: { containers: "RECOVER_IDS", hosts: "RECOVER_HOSTS", recoveryId: "RECOVERY_ID" },
    providerEnvironment: { authProviderKey: "APP_IDENTITY", allowedOriginsKey: "APP_ORIGINS" },
  });
  for (const name of ["APP_DATA_DIR", "APP_CONFIG", "RECOVER_IDS", "RECOVER_HOSTS", "RECOVERY_ID", "APP_IDENTITY", "APP_ORIGINS"]) {
    assert.equal(isRuntimeReservedEnvironmentName(name, { additionalReserved }), true, name);
  }
  assert.equal(isRuntimeReservedEnvironmentName("OTHER_DATA_DIR", { additionalReserved }), false);
});
