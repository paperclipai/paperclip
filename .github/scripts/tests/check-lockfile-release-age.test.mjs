import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addedPackageVersions,
  checkReleaseAge,
  formatReport,
  parseLockfilePackages,
} from '../check-lockfile-release-age.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2026-10-30T00:00:00Z');
const daysAgo = days => new Date(now.getTime() - days * DAY_MS);

const REGISTRY = '{integrity: sha512-x}';

// Each entry is a key, or [key, resolution] for a non-registry resolution.
const lockfile = entries => [
  "lockfileVersion: '9.0'",
  '',
  'importers:',
  '',
  '  .:',
  '    dependencies:',
  '      left-pad:',
  '        specifier: ^1.3.0',
  '        version: 1.3.0',
  '',
  'packages:',
  '',
  ...entries.flatMap(entry => {
    const [key, resolution] = Array.isArray(entry) ? entry : [entry, REGISTRY];
    return [`  ${key}:`, `    resolution: ${resolution}`, '    engines: {node: \'>=18\'}', ''];
  }),
  'snapshots:',
  '',
  '  snapshot-only@9.9.9:',
  '    dependencies: {}',
  '',
].join('\n');

const timesFrom = table => async (name, version) => {
  const value = table[`${name}@${version}`];
  if (value instanceof Error) throw value;
  return value ?? null;
};

test('parses plain, quoted and scoped package keys from the packages section only', () => {
  const packages = parseLockfilePackages(lockfile([
    "'@scope/pkg@2.0.0'",
    'left-pad@1.3.0',
    ['gitdep@https://codeload.github.com/o/r/tar.gz/abc', '{tarball: https://codeload.github.com/o/r/tar.gz/abc}'],
  ]));
  assert.deepEqual([...packages].sort(), [
    ['@scope/pkg@2.0.0', REGISTRY],
    ['gitdep@https://codeload.github.com/o/r/tar.gz/abc', '{tarball: https://codeload.github.com/o/r/tar.gz/abc}'],
    ['left-pad@1.3.0', REGISTRY],
  ]);
});

test('lists only package versions the refresh adds', () => {
  const base = lockfile(['left-pad@1.3.0', 'old@1.0.0']);
  const head = lockfile(['left-pad@1.3.0', 'old@1.1.0', "'@scope/new@0.1.0'"]);
  assert.deepEqual(addedPackageVersions(base, head), [
    { key: '@scope/new@0.1.0', name: '@scope/new', version: '0.1.0', resolution: REGISTRY },
    { key: 'old@1.1.0', name: 'old', version: '1.1.0', resolution: REGISTRY },
  ]);
});

test('lists an existing version whose resolution changed', () => {
  const swapped = ['left-pad@1.3.0', '{tarball: https://example.com/left-pad-1.3.0.tgz}'];
  assert.deepEqual(addedPackageVersions(lockfile(['left-pad@1.3.0']), lockfile([swapped])), [
    { key: 'left-pad@1.3.0', name: 'left-pad', version: '1.3.0', resolution: swapped[1] },
  ]);
});

test('holds unquoted URL keys and registry-looking keys with non-registry resolutions', async () => {
  const entries = addedPackageVersions(lockfile([]), lockfile([
    ['gitdep@https://codeload.github.com/o/r/tar.gz/abc', '{tarball: https://codeload.github.com/o/r/tar.gz/abc}'],
    ['sneaky@1.0.0', '{integrity: sha512-x, tarball: https://example.com/sneaky.tgz}'],
  ]));
  const result = await checkReleaseAge(entries, {
    fetchPublishTime: timesFrom({ 'sneaky@1.0.0': daysAgo(400) }),
    now,
    minAgeMs: DAY_MS,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.checked, 2);
  assert.deepEqual(
    Object.fromEntries(result.held.map(h => [h.name, h.reason])),
    {
      gitdep: 'not a registry version',
      sneaky: 'not a registry resolution: {integrity: sha512-x, tarball: https://example.com/sneaky.tgz}',
    },
  );
});

test('is eligible when every added version is old enough', async () => {
  const entries = addedPackageVersions(lockfile([]), lockfile(['a@1.0.0', "'@s/b@2.0.0'"]));
  const result = await checkReleaseAge(entries, {
    fetchPublishTime: timesFrom({ 'a@1.0.0': daysAgo(30), '@s/b@2.0.0': daysAgo(3.5) }),
    now,
    minAgeMs: 3 * DAY_MS,
  });
  assert.deepEqual(result, { eligible: true, checked: 2, held: [] });
});

test('is eligible when the refresh adds no package versions', async () => {
  const result = await checkReleaseAge([], { fetchPublishTime: timesFrom({}), now, minAgeMs: DAY_MS });
  assert.equal(result.eligible, true);
});

test('holds a version newer than the minimum age', async () => {
  const entries = addedPackageVersions(lockfile([]), lockfile(['old@1.0.0', 'fresh@1.0.1']));
  const result = await checkReleaseAge(entries, {
    fetchPublishTime: timesFrom({ 'old@1.0.0': daysAgo(30), 'fresh@1.0.1': daysAgo(0.5) }),
    now,
    minAgeMs: 3 * DAY_MS,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(result.held.map(h => h.key), ['fresh@1.0.1']);
  assert.match(result.held[0].reason, /0\.5 days ago/);
});

test('fails closed on lookup errors, missing publish times and non-registry versions', async () => {
  const entries = addedPackageVersions(
    lockfile([]),
    lockfile(['broken@1.0.0', 'unpublished@1.0.0', "'gitdep@https://codeload.github.com/o/r/tar.gz/abc'"]),
  );
  const result = await checkReleaseAge(entries, {
    fetchPublishTime: timesFrom({ 'broken@1.0.0': new Error('npm registry returned 503') }),
    now,
    minAgeMs: DAY_MS,
  });
  assert.equal(result.eligible, false);
  assert.deepEqual(
    Object.fromEntries(result.held.map(h => [h.name, h.reason])),
    {
      broken: 'registry lookup failed: npm registry returned 503',
      gitdep: 'not a registry version',
      unpublished: 'no publish time on npm',
    },
  );
});

test('report lists held versions behind a stable marker', () => {
  const report = formatReport(
    { eligible: false, checked: 1, held: [{ key: 'fresh@1.0.1', reason: 'too new' }] },
    3,
  );
  assert.match(report, /^<!-- lockfile-release-age -->/);
  assert.match(report, /- `fresh@1\.0\.1`: too new/);
});
