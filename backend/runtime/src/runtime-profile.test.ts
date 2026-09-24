import assert from "node:assert/strict";
import test from "node:test";
import { GENERIC_RUNTIME_PROFILE, runtimeProfileFromEnv, validateRuntimeProfile } from "./runtime-profile.js";

test("generic profiles do not require application recovery", () => {
  const profile = runtimeProfileFromEnv({});
  assert.equal(profile.recoveryCommand, undefined);
  assert.equal(profile.lockRecoveryEnvironment, undefined);
  validateRuntimeProfile(profile);
});

test("recovery is explicit, paired and executable-neutral", () => {
  const profile = runtimeProfileFromEnv({
    OPENAPP_RUNTIME_RECOVERY_COMMAND: '["/bin/recover","--repair"]',
    OPENAPP_RUNTIME_LOCK_CONTAINERS_ENV: "RECOVER_CONTAINERS",
    OPENAPP_RUNTIME_LOCK_HOSTS_ENV: "RECOVER_HOSTS",
    OPENAPP_RUNTIME_LOCK_ID_ENV: "RECOVER_ID",
  });
  assert.deepEqual(profile.recoveryCommand, ["/bin/recover", "--repair"]);
  assert.throws(() => validateRuntimeProfile({ ...GENERIC_RUNTIME_PROFILE, recoveryCommand: ["/bin/recover"] }), /declared together/);
  assert.throws(() => validateRuntimeProfile({ ...profile, recoveryCommand: [] }), /command is invalid/);
  assert.throws(() => validateRuntimeProfile({ ...profile, recoveryCommand: ["bad\0command"] }), /command is invalid/);
  assert.throws(() => runtimeProfileFromEnv({ OPENAPP_RUNTIME_RECOVERY_SCRIPT: "/old.mjs" }), /RECOVERY_COMMAND/);
  assert.throws(() => runtimeProfileFromEnv({ OPENAPP_RUNTIME_LOCK_ID_ENV: "RECOVER_ID" }), /declared together/);
});
