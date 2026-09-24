import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppVersion } from '../src/admin-api.ts';
import { isCurrentAppVersionMutation, isCurrentAppVersionRequest, sortAppVersions } from '../src/features/admin/app-catalog-state.ts';

function appVersion(id: string, revision: number | undefined, createdAt: string): AppVersion {
  return {
    id,
    appId: 'sample-app',
    revision,
    version: '0.5.20',
    buildId: id,
    packages: [],
    imageReference: null,
    status: 'image_ready',
    createdAt,
    activatedAt: null,
  };
}

test('App versions are ordered by newest revision before filtering and pagination', () => {
  const revision2 = appVersion('revision-2', 2, '2026-07-22T00:00:00.000Z');
  const revision10Older = appVersion('revision-10-older', 10, '2026-07-24T12:00:00.000Z');
  const revision10Newer = appVersion('revision-10-newer', 10, '2026-07-24T13:00:00.000Z');
  const legacy = appVersion('legacy-without-revision', undefined, '2026-07-25T00:00:00.000Z');

  const ordered = sortAppVersions([revision2, legacy, revision10Older, revision10Newer]);

  assert.deepEqual(ordered.map((version) => version.id), [
    'revision-10-newer',
    'revision-10-older',
    'revision-2',
    'legacy-without-revision',
  ]);
  assert.deepEqual([revision2, legacy, revision10Older, revision10Newer].map((version) => version.id), [
    'revision-2',
    'legacy-without-revision',
    'revision-10-older',
    'revision-10-newer',
  ]);
});

test('App version responses apply only to the current selection and request', () => {
  const current = {
    requestedAppId: 'app-a',
    selectedAppId: 'app-a',
    requestSequence: 3,
    latestSequence: 3,
    aborted: false,
  };

  assert.equal(isCurrentAppVersionRequest(current), true);
  assert.equal(isCurrentAppVersionRequest({ ...current, selectedAppId: 'app-b' }), false);
  assert.equal(isCurrentAppVersionRequest({ ...current, latestSequence: 4 }), false);
  assert.equal(isCurrentAppVersionRequest({ ...current, aborted: true }), false);
});

test('App version mutations cannot update a different selection or clear a newer busy state', () => {
  const current = {
    requestedAppId: 'app-a',
    selectedAppId: 'app-a',
    mutationSequence: 5,
    latestMutationSequence: 5,
    mounted: true,
  };

  assert.equal(isCurrentAppVersionMutation(current), true);
  assert.equal(isCurrentAppVersionMutation({ ...current, selectedAppId: 'app-b' }), false);
  assert.equal(isCurrentAppVersionMutation({ ...current, latestMutationSequence: 6 }), false);
  assert.equal(isCurrentAppVersionMutation({ ...current, mounted: false }), false);
});
