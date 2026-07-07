import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDedupSearch } from '../check-pr-dedup-search.mjs';

test('passes when dedup checkbox is checked (lowercase x)', () => {
  const body = `
## Checklist

- [x] I searched the GitHub PR list (open + recently closed) for similar PRs and confirmed this is not a duplicate
- [ ] Other thing
`;
  assert.equal(checkDedupSearch(body, 'feat: thing').passed, true);
});

test('passes when dedup checkbox is checked (uppercase X)', () => {
  const body = `- [X] I have searched GitHub for duplicate or related PRs and linked them above`;
  assert.equal(checkDedupSearch(body, 'feat: thing').passed, true);
});

test('passes with current PR template wording (master)', () => {
  const body = `
- [x] I have searched GitHub for duplicate or related PRs and linked them above
`;
  assert.equal(checkDedupSearch(body, 'feat: thing').passed, true);
});

test('fails when dedup checkbox is present but unchecked', () => {
  const body = `
- [ ] I searched for similar open/closed PRs and confirmed this is not a duplicate
- [ ] Other thing
`;
  const result = checkDedupSearch(body, 'feat: thing');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('fails when dedup checkbox is missing entirely', () => {
  const body = `
## Checklist

- [x] I have run tests locally
- [x] I have updated documentation
`;
  const result = checkDedupSearch(body, 'feat: thing');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('fails when PR body is empty (and no skip prefix)', () => {
  const result = checkDedupSearch('', 'feat: thing');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('skips check for docs: prefix', () => {
  assert.equal(checkDedupSearch('', 'docs: update README').passed, true);
});

test('skips check for chore: prefix', () => {
  assert.equal(checkDedupSearch('', 'chore: bump deps').passed, true);
});

test('skips check for ci: prefix', () => {
  assert.equal(checkDedupSearch('', 'ci: tweak workflow').passed, true);
});

test('skips check for test: prefix', () => {
  assert.equal(checkDedupSearch('', 'test: add coverage').passed, true);
});

test('requires checkbox for feat: prefix', () => {
  assert.equal(checkDedupSearch('Some description without checkbox', 'feat: new thing').passed, false);
});

test('does not match unrelated checked items mentioning "PR"', () => {
  const body = `
- [x] I have run tests locally and they pass
- [x] All Paperclip CI gates are green
`;
  assert.equal(checkDedupSearch(body, 'feat: thing').passed, false);
});

test('matches asterisk bullet style', () => {
  const body = `* [x] I searched GitHub for similar PRs and this is not a duplicate`;
  assert.equal(checkDedupSearch(body, 'feat: thing').passed, true);
});

test('does not match when "pr" only appears inside an unrelated word', () => {
  // "approaches" contains the letters "pr" but is not the token "PR/PRs".
  // Without a word-boundary anchor the regex would incorrectly pass.
  const body = `- [x] I searched for similar approaches to this problem`;
  assert.equal(checkDedupSearch(body, 'feat: thing').passed, false);
});
