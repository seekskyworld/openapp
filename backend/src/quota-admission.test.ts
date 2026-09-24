import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryQuotaAdmission,
  QuotaAdmissionError,
  type QuotaReservationRequest,
} from "./quota-admission.js";

const request = (overrides: Partial<QuotaReservationRequest> = {}): QuotaReservationRequest => ({
  reservationId: "reservation-1",
  userId: "user-1",
  tenantId: "tenant-1",
  providerId: "docker",
  desiredState: "running",
  cpuMillis: 1_000,
  memoryBytes: 1024,
  pidsLimit: 32,
  ...overrides,
});

test("quota admission enforces all configured scopes and reports the limiting dimension", async () => {
  const admission = new InMemoryQuotaAdmission({
    policy: {
      global: { instances: 10 },
      tenants: { "tenant-1": { runningInstances: 1, memoryBytes: 2048 } },
      users: { "user-1": { cpuMillis: 2_000 } },
    },
  });

  await admission.reserve(request());
  const denied = await admission.admit(request({ reservationId: "reservation-2" }));
  assert.deepEqual(denied, {
    status: "denied",
    reservationId: "reservation-2",
    code: "quota_exceeded",
    dimension: "runningInstances",
    scope: "tenant:tenant-1",
    retryable: false,
  });
});

test("reservation ids make retries idempotent and conflicting payloads fail closed", async () => {
  const admission = new InMemoryQuotaAdmission({ policy: { global: { instances: 1 } } });
  const first = await admission.reserve(request());
  const replay = await admission.reserve(request());
  assert.deepEqual(replay.request, first.request);
  await assert.rejects(
    admission.reserve(request({ memoryBytes: 2048 })),
    (error: unknown) => error instanceof QuotaAdmissionError && error.code === "quota_reservation_conflict",
  );
});

test("state transitions re-evaluate running capacity before mutating the ledger", async () => {
  const admission = new InMemoryQuotaAdmission({ policy: { global: { runningInstances: 1 } } });
  await admission.reserve(request({ desiredState: "stopped" }));
  await admission.reserve(request({ reservationId: "reservation-2", desiredState: "running" }));
  await assert.rejects(
    admission.transition("reservation-1", "running"),
    (error: unknown) => error instanceof QuotaAdmissionError
      && error.code === "quota_exceeded"
      && error.dimension === "runningInstances",
  );
  assert.equal(await admission.transition("reservation-1", "stopped"), true);
});

test("release is idempotent and unavailable quota is retryable", async () => {
  const admission = new InMemoryQuotaAdmission({ available: false });
  const decision = await admission.admit(request());
  assert.deepEqual(decision, {
    status: "unavailable",
    reservationId: "reservation-1",
    code: "quota_unavailable",
    retryable: true,
  });
  await assert.rejects(
    admission.reserve(request()),
    (error: unknown) => error instanceof QuotaAdmissionError
      && error.code === "quota_unavailable"
      && error.retryable,
  );
  admission.setAvailable(true);
  assert.equal(await admission.release("missing"), false);
  assert.equal(await admission.reserve(request()).then(() => true), true);
  assert.equal(await admission.release("reservation-1"), true);
  assert.equal(await admission.release("reservation-1"), false);
});

test("concurrent reservations are serialized instead of oversubscribing a scope", async () => {
  const admission = new InMemoryQuotaAdmission({ policy: { global: { instances: 1 } } });
  const results = await Promise.allSettled([
    admission.reserve(request({ reservationId: "reservation-a" })),
    admission.reserve(request({ reservationId: "reservation-b" })),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});
