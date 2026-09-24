import assert from "node:assert/strict";
import test from "node:test";
import {
  ForwardingPolicyError,
  ForwardingPolicyManager,
  type ForwardingPolicyStore,
} from "./forwarding-policy.js";
import type { ForwardingPolicy } from "./models.js";

function memoryStore() {
  let policy: ForwardingPolicy | undefined;
  const store: ForwardingPolicyStore = {
    async listForwardingPolicies() {
      return policy ? [policy] : [];
    },
    async upsertForwardingPolicy(input) {
      policy = { ...input, updatedAt: "2026-07-16T00:00:00.000Z" };
      return policy;
    },
  };
  return store;
}

test("forwarding policy supplies defaults and persists validated updates", async () => {
  const manager = new ForwardingPolicyManager(memoryStore(), {
    publicBaseUrl: "https://portal.example.com",
    allowedOrigins: ["https://admin.example.com"],
  });

  const initial = await manager.get();
  assert.equal(initial.targetBaseUrl, "https://portal.example.com");
  assert.deepEqual(initial.allowedHosts, ["https://portal.example.com", "https://admin.example.com"]);

  const updated = await manager.update({
    targetBaseUrl: "https://portal.example.com:8443",
    allowedHosts: ["*.example.com", "*.example.com"],
    enabled: false,
  }, "admin-1");
  assert.deepEqual(updated, {
    id: "default",
    name: "default",
    targetBaseUrl: "https://portal.example.com:8443",
    allowedHosts: ["*.example.com"],
    enabled: false,
    updatedBy: "admin-1",
    updatedAt: "2026-07-16T00:00:00.000Z",
  });
  assert.equal(manager.isInstanceOriginAllowed("https://tenant.example.com", updated), true);
  assert.equal(manager.isInstanceOriginAllowed("https://example.net", updated), false);
});

test("forwarding policy rejects unsafe targets and host lists", async () => {
  const manager = new ForwardingPolicyManager(memoryStore(), {
    publicBaseUrl: "http://127.0.0.1:4310",
    allowedOrigins: [],
  });
  await assert.rejects(
    manager.update({ targetBaseUrl: "file:///etc/passwd" }, "admin-1"),
    (error: unknown) => error instanceof ForwardingPolicyError && error.code === "invalid_forwarding_target",
  );
  await assert.rejects(
    manager.update({ targetBaseUrl: "http://localhost:4310" }, "admin-1"),
    (error: unknown) => error instanceof ForwardingPolicyError && error.code === "invalid_forwarding_target",
  );
  await assert.rejects(
    manager.update({ targetBaseUrl: "https://portal.example.com/control-plane" }, "admin-1"),
    (error: unknown) => error instanceof ForwardingPolicyError && error.code === "invalid_forwarding_target",
  );
  await assert.rejects(
    manager.update({ allowedHosts: ["bad host"] }, "admin-1"),
    (error: unknown) => error instanceof ForwardingPolicyError && error.code === "invalid_allowed_host",
  );
});

test("forwarding policy refreshes after a durable revision changes", async () => {
  let now = 1_000;
  let reads = 0;
  let policy: ForwardingPolicy | undefined;
  let revision = 0;
  const store: ForwardingPolicyStore = {
    async listForwardingPolicies() {
      reads += 1;
      return policy ? [policy] : [];
    },
    async upsertForwardingPolicy(input) {
      policy = { ...input, updatedAt: new Date(now).toISOString() };
      revision += 1;
      return policy;
    },
    async getConfigRevision() {
      return {
        key: "forwarding:default",
        revision,
        updatedBy: "test",
        updatedAt: new Date(now).toISOString(),
        effect: "immediate",
        effectiveAt: new Date(now).toISOString(),
      };
    },
  };
  const manager = new ForwardingPolicyManager(store, {
    publicBaseUrl: "https://portal.example.com",
    allowedOrigins: [],
  }, { cacheTtlMs: 100, now: () => now });

  assert.equal((await manager.get()).enabled, true);
  assert.equal(reads, 1);
  // The policy remains cached inside the TTL even if another process changes it.
  policy = {
    id: "default",
    name: "default",
    targetBaseUrl: "https://portal.example.com",
    allowedHosts: [],
    enabled: false,
    updatedBy: "other-process",
    updatedAt: new Date(now).toISOString(),
  };
  revision = 1;
  now += 101;
  assert.equal((await manager.get()).enabled, false);
  assert.equal(reads, 2);
});

test("an outdated refresh cannot overwrite a concurrent policy update", async () => {
  let now = 1_000;
  let revision = 0;
  let policy: ForwardingPolicy = {
    id: "default",
    name: "default",
    targetBaseUrl: "https://portal.example.com",
    allowedHosts: ["https://initial.example.com"],
    enabled: true,
    updatedBy: "system",
    updatedAt: new Date(now).toISOString(),
  };
  let pauseNextRead = false;
  let markReadStarted!: () => void;
  const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  const store: ForwardingPolicyStore = {
    async listForwardingPolicies() {
      const snapshot = structuredClone(policy);
      if (pauseNextRead) {
        pauseNextRead = false;
        markReadStarted();
        await readReleased;
      }
      return [snapshot];
    },
    async upsertForwardingPolicy(input) {
      revision += 1;
      policy = { ...input, allowedHosts: [...input.allowedHosts], updatedAt: new Date(now).toISOString() };
      return structuredClone(policy);
    },
    async getConfigRevision() {
      return {
        key: "forwarding:default",
        revision,
        updatedBy: policy.updatedBy,
        updatedAt: policy.updatedAt,
        effect: "immediate",
        effectiveAt: policy.updatedAt,
      };
    },
  };
  const manager = new ForwardingPolicyManager(store, {
    publicBaseUrl: "https://portal.example.com",
    allowedOrigins: [],
  }, { cacheTtlMs: 100, now: () => now });

  await manager.get();
  policy = {
    ...policy,
    allowedHosts: ["https://stale.example.com"],
    updatedBy: "other-process",
  };
  revision = 1;
  now += 101;
  pauseNextRead = true;
  const outdatedRefresh = manager.get();
  await readStarted;

  const updated = await manager.update({
    targetBaseUrl: "https://portal.example.com:8443",
    allowedHosts: ["https://current.example.com"],
    enabled: false,
  }, "admin-1", 1);
  releaseRead();

  assert.deepEqual(await outdatedRefresh, updated);
  assert.deepEqual(await manager.get(), updated);
});

test("forwarding policy invalidate forces a refresh without waiting for TTL", async () => {
  let reads = 0;
  let policy: ForwardingPolicy = {
    id: "default",
    name: "default",
    targetBaseUrl: "https://portal.example.com",
    allowedHosts: [],
    enabled: true,
    updatedBy: "system",
    updatedAt: new Date(0).toISOString(),
  };
  const store: ForwardingPolicyStore = {
    async listForwardingPolicies() {
      reads += 1;
      return [policy];
    },
    async upsertForwardingPolicy(input) {
      policy = { ...input, updatedAt: new Date().toISOString() };
      return policy;
    },
  };
  const manager = new ForwardingPolicyManager(store, {
    publicBaseUrl: "https://portal.example.com",
    allowedOrigins: [],
  }, { cacheTtlMs: 60_000 });

  await manager.get();
  policy = { ...policy, enabled: false };
  await manager.get();
  assert.equal(reads, 1);
  manager.invalidate();
  assert.equal((await manager.get()).enabled, false);
  assert.equal(reads, 2);
});
