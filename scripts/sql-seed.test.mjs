import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("canonical SQL is product-neutral and leaves catalog bootstrap to adapters", async () => {
  const sql = await readFile(join(root, "sql/container_service.sql"), "utf8");
  assert.match(sql, /app_id text NOT NULL/u);
  assert.doesNotMatch(sql, /^\s*(backend|web) jsonb/mu);
  assert.doesNotMatch(sql, /COPY public\.app_versions[^\n]*\b(?:backend|web)\b/u);
  assert.match(sql, /source_kind text DEFAULT 'packages'::text NOT NULL CHECK/u);
  assert.match(sql, /auth_method text DEFAULT 'external'::text NOT NULL/u);
  assert.match(sql, /COPY public\.apps[\s\S]*?FROM stdin;\n\\\./u);
  assert.match(sql, /COPY public\.build_strategies[\s\S]*?FROM stdin;\n\\\./u);
  assert.match(sql, /COPY public\.provisioning_policy[\s\S]*?FROM stdin;\n\\\./u);
  for (const match of sql.matchAll(/COPY public\.([a-z_]+)[^\n]*FROM stdin;\n([\s\S]*?)\\\./gu)) {
    assert.equal(match[2].trim(), "", `seed must not contain operational rows: ${match[1]}`);
  }
});
