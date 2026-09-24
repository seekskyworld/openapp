import assert from "node:assert/strict";
import test from "node:test";
import { LocalAuthRateLimiter, type LocalAuthRateLimitPolicies } from "./local-auth-rate-limit.js";

const policies: LocalAuthRateLimitPolicies = {
  login: { windowMs: 1_000, attemptsPerSource: 2, attemptsPerAccount: 1 },
  register: { windowMs: 1_000, attemptsPerSource: 1, attemptsPerAccount: 1 },
  "password-setup": { windowMs: 1_000, attemptsPerSource: 1, attemptsPerAccount: 1 },
  "password-change": { windowMs: 1_000, attemptsPerSource: 1, attemptsPerAccount: 1 },
  "external-password-code": { windowMs: 1_000, attemptsPerSource: 1, attemptsPerAccount: 1 },
  "external-password-change": { windowMs: 1_000, attemptsPerSource: 1, attemptsPerAccount: 1 },
};

test("local auth attempts are limited independently by source and account", () => {
  let now = 0;
  const limiter = new LocalAuthRateLimiter(policies, () => now);

  assert.equal(limiter.consume("login", "source-a", "first@example.com"), true);
  assert.equal(limiter.consume("login", "source-b", "first@example.com"), false);
  assert.equal(limiter.consume("login", "source-a", "second@example.com"), true);
  assert.equal(limiter.consume("login", "source-a", "third@example.com"), false);

  now = 1_001;
  assert.equal(limiter.consume("login", "source-a", "first@example.com"), true);
});

test("registration uses its stricter policy", () => {
  const limiter = new LocalAuthRateLimiter(policies);
  assert.equal(limiter.consume("register", "source-a", "first@example.com"), true);
  assert.equal(limiter.consume("register", "source-a", "second@example.com"), false);
});

test("credential operations have independent source and account budgets", () => {
  const limiter = new LocalAuthRateLimiter(policies);
  for (const operation of ["password-setup", "password-change", "external-password-code", "external-password-change"] as const) {
    assert.equal(limiter.consume(operation, "source-a", "first@example.com"), true);
    assert.equal(limiter.consume(operation, "source-b", "first@example.com"), false);
  }
});
