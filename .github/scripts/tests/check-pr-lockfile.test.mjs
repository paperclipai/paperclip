import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLockfile } from '../check-pr-lockfile.mjs';

const makeFiles = (filenames) => filenames.map(f => ({ filename: f, status: 'modified' }));

test('passes when lockfile is not changed', () => {
  assert.equal(checkLockfile(makeFiles(['src/foo.ts']), 'someuser', 'fix/bug').passed, true);
});

test('passes when lockfile changed by refresh bot on correct branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'chore/refresh-lockfile'
  );
  assert.equal(result.passed, true);
});

test('fails when lockfile changed by regular user', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('pnpm-lock.yaml'));
});

test('fails when lockfile changed by bot on wrong branch', () => {
  const result = checkLockfile(
    makeFiles(['pnpm-lock.yaml']),
    'github-actions[bot]',
    'fix/something-else'
  );
  assert.equal(result.passed, false);
});

test('passes when Dependabot changes the lockfile', () => {
  assert.equal(checkLockfile(makeFiles(['pnpm-lock.yaml', 'package.json']), 'dependabot[bot]', 'dependabot/npm_and_yarn/zod-4.6.6').passed, true);
});

test('fails when Dependabot changes the reporting-lock proof', () => {
  const result = checkLockfile(makeFiles(['pnpm-lock.yaml', 'tests/runner-e2e/report-lock.json']), 'dependabot[bot]', 'dependabot/npm_and_yarn/zod-4.6.6');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('report-lock.json'));
});

test('fails when a regular user changes the reporting-lock proof', () => {
  const result = checkLockfile(makeFiles(['tests/runner-e2e/report-lock.patch']), 'someuser', 'fix/bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('report-lock.patch'));
});

test('fails when a regular user changes a sandbox provider lockfile', () => {
  for (const file of ['scripts/typecheck-sandbox-providers/pnpm-lock.yaml', 'packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml']) {
    const result = checkLockfile(makeFiles([file]), 'someuser', 'fix/bug');
    assert.equal(result.passed, false, file);
    assert.ok(result.failures[0].includes(file));
  }
});

test('passes when Dependabot changes a sandbox provider lockfile', () => {
  const files = makeFiles(['packages/plugins/sandbox-providers/daytona/package.json', 'packages/plugins/sandbox-providers/daytona/pnpm-lock.yaml']);
  assert.equal(checkLockfile(files, 'dependabot[bot]', 'dependabot/npm_and_yarn/packages/plugins/sandbox-providers/daytona/zod-4.6.6').passed, true);
});
