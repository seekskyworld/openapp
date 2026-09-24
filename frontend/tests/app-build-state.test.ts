import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMatchesVersion,
  createAppImageUpdateDraft,
  currentAppRevision,
  inheritedPackageIdsForRevision,
  packagesForAppVersion,
  replaceAppImageUpdatePackage,
  resetAppImageUpdateSlot,
  resolveAppImageUpdateDraft,
  selectedPackageIds,
  versionSupportsStrategy,
} from '../src/features/admin/app-build-state.ts';
import type { AppVersion, BuildStrategy } from '../src/admin-api.ts';

const strategy: BuildStrategy = {
  id: 'generic',
  revision: 2,
  name: 'Generic',
  description: '',
  runtimeContract: 'generic-v1',
  packageRequirements: [
    { key: 'backend', required: true, acceptedExtensions: ['.tgz'] },
    { key: 'web', required: true, acceptedExtensions: ['.tar.gz'] },
    { key: 'symbols', required: false, acceptedExtensions: ['.zip'] },
  ],
  status: 'active',
  createdAt: '2026-07-17T00:00:00.000Z',
  updatedAt: '2026-07-17T00:00:00.000Z',
};

const backend = { file: 'backend.tgz', sha256: 'a'.repeat(64), size: 10 };
test('optional slots can be removed while required slots cannot become buildable when removed', () => {
  const draft = createAppImageUpdateDraft({ backend: 'b', web: 'w', symbols: 's' });
  const removed = replaceAppImageUpdatePackage(draft, 'symbols', null);
  const result = resolveAppImageUpdateDraft(strategy, removed);
  assert.deepEqual(result.packageIds, ['b', 'w']);
  assert.deepEqual(result.changedSlots, ['symbols']);
  assert.equal(result.canBuild, true);
  assert.equal(resolveAppImageUpdateDraft(strategy, replaceAppImageUpdatePackage(draft, 'backend', null)).canBuild, false);
  assert.equal(resetAppImageUpdateSlot(removed, 'symbols').replacementPackageIds.symbols, undefined);
});
const web = { file: 'web.tar.gz', sha256: 'b'.repeat(64), size: 20 };
const version: AppVersion = {
  id: 'version-1',
  appId: 'demo',
  version: '1.0.0',
  buildId: 'build-1',
  packages: [{ key: 'backend', artifact: backend }, { key: 'web', artifact: web }],
  imageReference: null,
  status: 'uploaded',
  createdAt: '2026-07-17T00:00:00.000Z',
  activatedAt: null,
};

test('an App image update can replace only backend and inherit the current web package', () => {
  const inheritedPackageIds = { backend: 'backend-build-a', web: 'web-build-b' };
  const draft = replaceAppImageUpdatePackage(
    createAppImageUpdateDraft(inheritedPackageIds),
    'backend',
    'backend-build-c',
  );

  assert.deepEqual(resolveAppImageUpdateDraft(strategy, draft), {
    effectivePackageIds: { backend: 'backend-build-c', web: 'web-build-b' },
    packageIds: ['backend-build-c', 'web-build-b'],
    changedSlots: ['backend'],
    missingRequiredSlots: [],
    canBuild: true,
  });
  assert.deepEqual(inheritedPackageIds, { backend: 'backend-build-a', web: 'web-build-b' });
});

test('an App image update inherits package identities from the current Revision', () => {
  const current = {
    ...version,
    id: 'revision-4',
    revision: 4,
    status: 'active' as const,
    packages: [
      { key: 'backend', packageId: 'backend-package-4', artifact: backend },
      { key: 'web', packageId: 'web-package-9', artifact: web },
    ],
  };
  const candidate = { ...current, id: 'revision-5', revision: 5, status: 'image_ready' as const };
  const legacy = { ...current, id: 'revision-legacy', status: 'legacy' as const };

  assert.equal(currentAppRevision([candidate, current]), current);
  assert.deepEqual(inheritedPackageIdsForRevision(current), {
    backend: 'backend-package-4',
    web: 'web-package-9',
  });
  assert.equal(currentAppRevision([candidate]), null);
  assert.equal(currentAppRevision([candidate, legacy]), legacy);
});

test('an App image update can replace only web regardless of backend package version', () => {
  const draft = replaceAppImageUpdatePackage(
    createAppImageUpdateDraft({ backend: 'backend-v2.3.0', web: 'web-v9.0.1' }),
    'web',
    ' web-v9.1.0 ',
  );

  assert.deepEqual(resolveAppImageUpdateDraft(strategy, draft), {
    effectivePackageIds: { backend: 'backend-v2.3.0', web: 'web-v9.1.0' },
    packageIds: ['backend-v2.3.0', 'web-v9.1.0'],
    changedSlots: ['web'],
    missingRequiredSlots: [],
    canBuild: true,
  });
});

test('an App image update can replace backend and web while inheriting an optional slot', () => {
  const initialDraft = createAppImageUpdateDraft({
    backend: 'backend-old',
    web: 'web-old',
    symbols: ' symbols-old ',
  });
  const backendDraft = replaceAppImageUpdatePackage(initialDraft, 'backend', 'backend-new');
  const draft = replaceAppImageUpdatePackage(backendDraft, 'web', 'web-new');

  assert.deepEqual(resolveAppImageUpdateDraft(strategy, draft), {
    effectivePackageIds: {
      backend: 'backend-new',
      web: 'web-new',
      symbols: 'symbols-old',
    },
    packageIds: ['backend-new', 'web-new', 'symbols-old'],
    changedSlots: ['backend', 'web'],
    missingRequiredSlots: [],
    canBuild: true,
  });
});

test('an App image update cannot build while a required inherited slot is missing', () => {
  const draft = replaceAppImageUpdatePackage(
    createAppImageUpdateDraft({ backend: 'backend-current' }),
    'backend',
    'backend-new',
  );

  assert.deepEqual(resolveAppImageUpdateDraft(strategy, draft), {
    effectivePackageIds: { backend: 'backend-new' },
    packageIds: null,
    changedSlots: ['backend'],
    missingRequiredSlots: ['web'],
    canBuild: false,
  });
});

test('resetting one replacement restores only that slot to its inherited package', () => {
  const initialDraft = createAppImageUpdateDraft({ backend: 'backend-old', web: 'web-old' });
  const backendDraft = replaceAppImageUpdatePackage(initialDraft, 'backend', 'backend-new');
  const bothDraft = replaceAppImageUpdatePackage(backendDraft, 'web', 'web-new');
  const resetDraft = resetAppImageUpdateSlot(bothDraft, 'backend');

  assert.deepEqual(resolveAppImageUpdateDraft(strategy, resetDraft), {
    effectivePackageIds: { backend: 'backend-old', web: 'web-new' },
    packageIds: ['backend-old', 'web-new'],
    changedSlots: ['web'],
    missingRequiredSlots: [],
    canBuild: true,
  });
  assert.deepEqual(resolveAppImageUpdateDraft(strategy, bothDraft).changedSlots, ['backend', 'web']);
});

test('selecting the inherited package keeps replacementPackageIds submission-only', () => {
  const initialDraft = createAppImageUpdateDraft({ backend: 'backend-old', web: 'web-old' });
  const replacedDraft = replaceAppImageUpdatePackage(initialDraft, 'backend', 'backend-new');
  const inheritedDraft = replaceAppImageUpdatePackage(replacedDraft, 'backend', 'backend-old');
  const blankDraft = replaceAppImageUpdatePackage(inheritedDraft, 'web', '   ');

  assert.deepEqual(inheritedDraft.replacementPackageIds, {});
  assert.deepEqual(blankDraft.replacementPackageIds, {});
  assert.equal(resolveAppImageUpdateDraft(strategy, blankDraft).canBuild, false);
});

test('package selection follows strategy slot order and requires only required slots', () => {
  assert.equal(selectedPackageIds(strategy, { backend: 'backend-1' }), null);
  assert.deepEqual(selectedPackageIds(strategy, {
    web: 'web-1',
    symbols: 'symbols-1',
    backend: 'backend-1',
  }), ['backend-1', 'web-1', 'symbols-1']);
});

test('App Versions expose only the server-provided package slots', () => {
  assert.deepEqual(packagesForAppVersion(version).map((entry) => entry.key), ['backend', 'web']);
  assert.equal(versionSupportsStrategy(version, strategy), true);
  assert.equal(versionSupportsStrategy({ ...version, packages: [{ key: 'backend', artifact: backend }] }, strategy), false);
});

test('artifact binding candidates must have the same strategy package snapshot', () => {
  const build = {
    id: 'image-build-1',
    strategyId: strategy.id,
    strategySnapshot: strategy,
    operationId: null,
    sourceAppVersionId: null,
    requestedBy: 'admin-1',
    packages: [
      { key: 'backend', artifact: backend },
      { key: 'web', artifact: web },
    ],
    status: 'succeeded' as const,
    error: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    startedAt: '2026-07-17T00:00:00.000Z',
    finishedAt: '2026-07-17T00:01:00.000Z',
  };
  assert.equal(buildMatchesVersion(build, version), true);
  assert.equal(buildMatchesVersion({
    ...build,
    packages: [
      { key: 'backend', artifact: { ...backend, size: 11 } },
      { key: 'web', artifact: web },
    ],
  }, version), false);
  assert.equal(buildMatchesVersion({ ...build, sourceAppVersionId: 'another-version' }, version), false);
});
