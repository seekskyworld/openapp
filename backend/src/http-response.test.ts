import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { HttpError, readJsonBody } from "./http-response.js";

function requestFrom(value: string): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(value)]), {
    headers: { "content-type": "application/json" },
  }) as IncomingMessage;
}

test("readJsonBody accepts an object and enforces the byte limit", async () => {
  assert.deepEqual(await readJsonBody(requestFrom('{"ok":true}')), { ok: true });
  await assert.rejects(
    readJsonBody(requestFrom('{"too":"large"}'), 4),
    (error: unknown) =>
      error instanceof HttpError && error.status === 413 && error.message === "body_too_large",
  );
});

test("readJsonBody rejects arrays and malformed JSON at the HTTP seam", async () => {
  await assert.rejects(
    readJsonBody(requestFrom("[]")),
    (error: unknown) =>
      error instanceof HttpError && error.status === 400 && error.message === "invalid_json_object",
  );
  await assert.rejects(
    readJsonBody(requestFrom("{")),
    (error: unknown) =>
      error instanceof HttpError && error.status === 400 && error.message === "invalid_json",
  );
});
