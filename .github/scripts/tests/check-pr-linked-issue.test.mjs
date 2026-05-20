import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinkedIssue } from '../check-pr-linked-issue.mjs';

test('passes with bare #NNN reference', () => {
  assert.equal(checkLinkedIssue('This fixes the bug in #123').passed, true);
});

test('passes with "Fixes #NNN"', () => {
  assert.equal(checkLinkedIssue('Fixes #456\n\nSome description').passed, true);
});

test('passes with "Closes #NNN" (case-insensitive)', () => {
  assert.equal(checkLinkedIssue('closes #789').passed, true);
});

test('passes with "Resolves #NNN"', () => {
  assert.equal(checkLinkedIssue('Resolves #101').passed, true);
});

test('passes with full github.com URL', () => {
  assert.equal(
    checkLinkedIssue('See https://github.com/paperclipai/paperclip/issues/202').passed,
    true
  );
});

test('fails with empty body', () => {
  const result = checkLinkedIssue('');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('fails with no issue reference', () => {
  const result = checkLinkedIssue('Added a cool feature, no issue linked');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('Fixes #NNN'));
});

test('fails with issue reference from different repo', () => {
  const result = checkLinkedIssue('See https://github.com/other/repo/issues/123');
  assert.equal(result.passed, false);
});

test('fails when #NNN is part of a word (no space before)', () => {
  const result = checkLinkedIssue('This is version#123 not an issue link');
  assert.equal(result.passed, false);
});
