import assert from "node:assert/strict";
import test from "node:test";

import {
  createOperationContext,
  diagnosticContext,
  formatDiagnosticContext,
  mergeOperationContext,
} from "./operation-context.js";

test("operation context keeps only stable correlation fields", () => {
  const context = createOperationContext({
    requestId: "request-1",
    operationId: "operation-1",
    workspaceId: "workspace-1",
    attemptId: "attempt-1",
    providerId: "docker",
    phase: "reconcile",
    token: "must-not-be-copied",
  });

  assert.deepEqual(diagnosticContext(context), {
    requestId: "request-1",
    operationId: "operation-1",
    workspaceId: "workspace-1",
    attemptId: "attempt-1",
    providerId: "docker",
    phase: "reconcile",
  });
  assert.doesNotMatch(formatDiagnosticContext(context), /must-not-be-copied/u);
});

test("invalid external identifiers are omitted or replaced without echoing secrets", () => {
  const context = createOperationContext({
    requestId: "https://internal.example/token?secret=hidden",
    operationId: "bad value",
    workspaceId: "workspace/with/slash",
    attemptId: 42,
    providerId: "docker",
    phase: "not-a-phase",
  });

  assert.match(context.requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(context.operationId, undefined);
  assert.equal(context.workspaceId, undefined);
  assert.equal(context.attemptId, undefined);
  assert.equal(context.providerId, "docker");
  assert.equal(context.phase, "unknown");
  assert.doesNotMatch(formatDiagnosticContext(context), /secret|internal\.example/u);
});

test("context merge preserves fields and supports explicit clearing", () => {
  const base = createOperationContext({
    requestId: "request-1",
    operationId: "operation-1",
    workspaceId: "workspace-1",
    attemptId: "attempt-1",
    providerId: "docker",
    phase: "execution",
  });
  const merged = mergeOperationContext(base, {
    phase: "diagnose",
    attemptId: null,
  });

  assert.deepEqual(diagnosticContext(merged), {
    requestId: "request-1",
    operationId: "operation-1",
    workspaceId: "workspace-1",
    providerId: "docker",
    phase: "diagnose",
  });
});

test("missing request ids receive a local correlation id", () => {
  const context = createOperationContext({ phase: "http" });
  assert.match(context.requestId, /^[0-9a-f-]{36}$/u);
  assert.equal(context.phase, "http");
});
