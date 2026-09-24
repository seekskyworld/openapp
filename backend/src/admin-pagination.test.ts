import assert from "node:assert/strict";
import test from "node:test";
import { paginateAdminList } from "./admin-pagination.js";

test("admin pagination returns stable metadata and clamps an empty last page", () => {
  const values = Array.from({ length: 45 }, (_, index) => index + 1);
  const result = paginateAdminList(values, new URL("http://localhost/admin?page=9&pageSize=20"));

  assert.deepEqual(result.items, [41, 42, 43, 44, 45]);
  assert.deepEqual(result.pagination, {
    page: 3,
    pageSize: 20,
    total: 45,
    totalPages: 3,
    hasNext: false,
  });
});

test("admin pagination supports all and preserves legacy unpaged requests", () => {
  const values = Array.from({ length: 125 }, (_, index) => index);
  for (const url of ["http://localhost/admin", "http://localhost/admin?pageSize=all"]) {
    const result = paginateAdminList(values, new URL(url));
    assert.equal(result.items.length, 125);
    assert.deepEqual(result.pagination, {
      page: 1,
      pageSize: "all",
      total: 125,
      totalPages: 1,
      hasNext: false,
    });
  }
});

test("admin pagination rejects unsupported page sizes", () => {
  assert.throws(
    () => paginateAdminList([], new URL("http://localhost/admin?pageSize=500")),
    (error: unknown) => error instanceof Error && error.message === "invalid_page_size",
  );
});
