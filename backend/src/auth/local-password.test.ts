import assert from "node:assert/strict";
import test from "node:test";
import { hashLocalPassword, validateLocalPassword, verifyLocalPassword } from "./local-password.js";

test("local passwords use a salted scrypt format", async () => {
  const first = await hashLocalPassword("correct horse battery staple");
  const second = await hashLocalPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(await verifyLocalPassword("correct horse battery staple", first), true);
  assert.equal(await verifyLocalPassword("wrong password", first), false);
  assert.equal(await verifyLocalPassword("correct horse battery staple", "invalid"), false);
});

test("local password policy rejects weak or oversized values", () => {
  assert.throws(() => validateLocalPassword("short"), /password_too_short/u);
  assert.throws(() => validateLocalPassword("密码密码"), /password_too_short/u);
  assert.equal(validateLocalPassword("密码密码密码密码密码密码"), "密码密码密码密码密码密码");
  assert.throws(() => validateLocalPassword("x".repeat(257)), /password_too_long/u);
});
