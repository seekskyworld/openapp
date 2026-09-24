import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeAdminPageSize, paginateItems } from '../src/features/admin/shared.tsx';

test('admin page size restores only supported persistent values', () => {
  assert.equal(normalizeAdminPageSize('20'), 20);
  assert.equal(normalizeAdminPageSize('50'), 50);
  assert.equal(normalizeAdminPageSize('100'), 100);
  assert.equal(normalizeAdminPageSize('all'), 'all');
  assert.equal(normalizeAdminPageSize('500'), 20);
  assert.equal(normalizeAdminPageSize(null, 50), 50);
});

test('admin pagination clamps a page after filtered data shrinks', () => {
  const values = Array.from({ length: 25 }, (_, index) => index + 1);
  assert.deepEqual(paginateItems(values, 3, 20), values.slice(20));
  assert.deepEqual(paginateItems(values.slice(0, 5), 3, 20), values.slice(0, 5));
  assert.deepEqual(paginateItems(values, 9, 'all'), values);
});
