import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTestCoverage } from '../check-pr-test-coverage.mjs';

const makeFiles = (filenames) =>
  filenames.map(filename => ({ filename, status: 'modified' }));

test('passes when .test.ts file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/foo.test.ts', 'src/foo.ts'])).passed, true);
});

test('passes when .spec.js file is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/bar.spec.js'])).passed, true);
});

test('passes when file under tests/ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['tests/unit/baz.ts'])).passed, true);
});

test('passes when file under __tests__ is changed', () => {
  assert.equal(checkTestCoverage(makeFiles(['src/__tests__/qux.ts'])).passed, true);
});

test('fails when only non-test files are changed', () => {
  const result = checkTestCoverage(makeFiles(['src/foo.ts', 'src/bar.ts']));
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('test'));
});

test('fails with empty file list', () => {
  assert.equal(checkTestCoverage([]).passed, false);
});

test('ignores removed test files', () => {
  const files = [
    { filename: 'src/foo.test.ts', status: 'removed' },
    { filename: 'src/foo.ts', status: 'modified' },
  ];
  assert.equal(checkTestCoverage(files).passed, false);
});
