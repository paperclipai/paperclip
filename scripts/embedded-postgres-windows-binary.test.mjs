import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const embeddedPostgresVersion = '18.1.0-beta.15';
const workspaceManifests = [
  'cli/package.json',
  'packages/db/package.json',
  'server/package.json',
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('Windows embedded Postgres binary matches the wrapper version', () => {
  for (const manifestPath of workspaceManifests) {
    const manifest = readJson(manifestPath);

    assert.equal(
      manifest.dependencies?.['embedded-postgres'],
      embeddedPostgresVersion,
      `${manifestPath} should pin embedded-postgres so the platform binary cannot drift`,
    );
    assert.equal(
      manifest.optionalDependencies?.['@embedded-postgres/windows-x64'],
      embeddedPostgresVersion,
      `${manifestPath} should install the matching Windows x64 binary`,
    );
  }
});

test('embedded-postgres patch is registered for the pinned version', () => {
  const rootManifest = readJson('package.json');
  const patchPath = `patches/embedded-postgres@${embeddedPostgresVersion}.patch`;

  assert.equal(
    rootManifest.pnpm?.patchedDependencies?.[`embedded-postgres@${embeddedPostgresVersion}`],
    patchPath,
  );
  assert.equal(existsSync(patchPath), true);
});
