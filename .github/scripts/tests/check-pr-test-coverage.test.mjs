import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTestCoverage } from '../check-pr-test-coverage.mjs';

const makeFiles = (filenames) =>
  filenames.map(filename => ({ filename, status: 'modified' }));

// Existing tests with title parameter added (fix: prefix means test required)

test('passes when .test.ts file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts', 'src/foo.ts']), 'fix: bug').passed, true);
});

test('passes when .spec.js file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/bar.spec.js']), 'fix: bug').passed, true);
});

test('passes when file under tests/ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['tests/unit/baz.ts']), 'fix: bug').passed, true);
});

test('passes when file under __tests__ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/__tests__/qux.ts']), 'fix: bug').passed, true);
});

test('fails when fix: PR has no tests', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts', 'src/bar.ts']), 'fix: bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('test'));
});

test('fails when feat: PR has no tests', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'feat: new feature');
  assert.equal(result.passed, false);
});

test('fails with empty file list and fix: prefix', () => {
  assert.equal(checkTestCoverage([], 'fix: bug').passed, false);
});

test('ignores removed test files', () => {
  const files = [
    { filename: 'src/foo.test.ts', status: 'removed' },
    { filename: 'src/foo.ts', status: 'modified' },
  ];
  assert.equal(checkTestCoverage(files, 'fix: bug').passed, false);
});

// New tests for prefix-aware skip behavior

test('skips test requirement for docs: prefix (markdown only)', () => {
  assert.equal(checkTestCoverage(makeFiles(['README.md', 'docs/setup.md']), 'docs: update guide').passed, true);
});

test('skips test requirement for chore: prefix (config only)', () => {
  assert.equal(checkTestCoverage(makeFiles(['.gitignore', '.github/labels.yml']), 'chore: cleanup').passed, true);
});

test('skips test requirement for refactor: prefix', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.ts']), 'refactor: rename function').passed, true);
});

test('skips test requirement for style: prefix', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.ts']), 'style: format').passed, true);
});

// New tests for mismatch detection

test('flags docs: PR with source code changes', () => {
  const result = checkTestCoverage(makeFiles(['src/api.ts', 'README.md']), 'docs: update docs');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('docs:'));
  assert.ok(result.failures[0].includes('source code'));
});

test('flags chore: PR with source code changes', () => {
  const result = checkTestCoverage(makeFiles(['src/server.ts']), 'chore: cleanup');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('chore:'));
});

test('does NOT flag chore: PR with only config files', () => {
  const result = checkTestCoverage(makeFiles(['package.json', '.eslintrc.js']), 'chore: bump');
  // .eslintrc.js is a .js file but it's config — current rule will flag it. This documents that.
  // For now we err on the side of flagging — contributor can retitle if needed.
  assert.equal(result.passed, false);
});

test('does NOT flag refactor: PR with source code (refactor expects source changes)', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'refactor: rename');
  assert.equal(result.passed, true);
});

test('requires test when no prefix used', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts']), 'Some PR with no prefix');
  assert.equal(result.passed, false);
});

test('handles scoped prefix like fix(server):', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts', 'src/foo.ts']), 'fix(server): bug').passed, true);
});
