import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public logo contains only image data and no personal or provenance metadata", async () => {
  const data = await readFile(new URL("../frontend/public/openapp-logo.png", import.meta.url));
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  let offset = 8;
  while (offset < data.length) {
    const size = data.readUInt32BE(offset);
    const type = data.subarray(offset + 4, offset + 8).toString();
    assert.ok(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"].includes(type), `unexpected PNG metadata: ${type}`);
    offset += size + 12;
    assert.ok(offset <= data.length);
    if (type === "IEND") assert.equal(offset, data.length);
  }
  assert.equal(offset, data.length);
});
