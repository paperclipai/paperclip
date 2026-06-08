import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLinkedIssue, hasInlineIssueDescription } from '../check-pr-linked-issue.mjs';

// Existing tests with title parameter added (defaults to no prefix, so still required)

test('passes with bare #NNN reference', () => {
  assert.equal(checkLinkedIssue('This fixes the bug in #123', 'fix: something').passed, true);
});

test('passes with "Fixes #NNN"', () => {
  assert.equal(checkLinkedIssue('Fixes #456\n\nSome description', 'fix: something').passed, true);
});

test('passes with "Closes #NNN" (case-insensitive)', () => {
  assert.equal(checkLinkedIssue('closes #789', 'fix: something').passed, true);
});

test('passes with "Resolves #NNN"', () => {
  assert.equal(checkLinkedIssue('Resolves #101', 'fix: something').passed, true);
});

test('passes with "Refs #NNN"', () => {
  assert.equal(checkLinkedIssue('Refs #202', 'fix: something').passed, true);
});

test('passes with "refs #NNN" (case-insensitive)', () => {
  assert.equal(checkLinkedIssue('refs #303', 'fix: something').passed, true);
});

test('passes with full github.com URL', () => {
  assert.equal(
    checkLinkedIssue('See https://github.com/paperclipai/paperclip/issues/202', 'fix: bug').passed,
    true
  );
});

test('passes with a full github.com URL followed by punctuation', () => {
  assert.equal(
    checkLinkedIssue('See (https://github.com/paperclipai/paperclip/issues/202).', 'fix: bug').passed,
    true
  );
});

test('fails with empty body when no skip prefix', () => {
  const result = checkLinkedIssue('', 'fix: bug');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('fails with no issue reference when no skip prefix', () => {
  const result = checkLinkedIssue('Added a cool feature, no issue linked', 'feat: something');
  assert.equal(result.passed, false);
  assert.ok(result.failures[0].includes('Fixes #NNN'));
});

test('fails with cross-repo issue reference', () => {
  const result = checkLinkedIssue('See https://github.com/other/repo/issues/123', 'fix: bug');
  assert.equal(result.passed, false);
});

test('fails when the Paperclip issue URL is embedded inside another host', () => {
  const result = checkLinkedIssue(
    'See https://evil.example/https://github.com/paperclipai/paperclip/issues/123',
    'fix: bug'
  );
  assert.equal(result.passed, false);
});

test('fails when the Paperclip issue URL continues into another host', () => {
  const result = checkLinkedIssue(
    'See https://github.com/paperclipai/paperclip/issues/123.evil.example',
    'fix: bug'
  );
  assert.equal(result.passed, false);
});

test('fails when #NNN is part of a word (no space before)', () => {
  const result = checkLinkedIssue('This is version#123 not an issue link', 'fix: bug');
  assert.equal(result.passed, false);
});

// Prefix-aware skip behavior

test('skips check for docs: prefix', () => {
  assert.equal(checkLinkedIssue('', 'docs: update README').passed, true);
});

test('skips check for chore: prefix', () => {
  assert.equal(checkLinkedIssue('', 'chore: bump deps').passed, true);
});

test('skips check for build: prefix', () => {
  assert.equal(checkLinkedIssue('', 'build: update Dockerfile').passed, true);
});

test('skips check for ci: prefix', () => {
  assert.equal(checkLinkedIssue('', 'ci: add workflow').passed, true);
});

test('skips check for test: prefix', () => {
  assert.equal(checkLinkedIssue('', 'test: add coverage').passed, true);
});

test('skips check with scoped prefix like docs(api):', () => {
  assert.equal(checkLinkedIssue('', 'docs(api): document endpoint').passed, true);
});

test('requires issue for feat: prefix', () => {
  assert.equal(checkLinkedIssue('Some description without issue', 'feat: new thing').passed, false);
});

test('requires issue for refactor: prefix', () => {
  assert.equal(checkLinkedIssue('Some refactor', 'refactor: rewrite thing').passed, false);
});

test('requires issue when no prefix (encourages prefix usage)', () => {
  assert.equal(checkLinkedIssue('No prefix here', 'Add some feature').passed, false);
});

// Inline issue description (path 2)

const BUG_INLINE_BODY = `
## What happened?

Login button does nothing when clicked.

## Expected behavior

Clicking the login button should authenticate the user.

## Steps to reproduce

1. Open the app
2. Click login
3. Nothing happens
`;

const FEATURE_INLINE_BODY = `
## Problem or motivation

We don't have a way to bulk-tag issues.

## Proposed solution

Add a bulk-tag action to the issues list.

## Alternatives considered

Tagging individually — too slow.
`;

const ADAPTER_INLINE_BODY = `
## Agent or provider

Gemini CLI

## Why this adapter is useful

Lots of users want Gemini as an alternative model option.

## How the agent is invoked

Via the \`gemini\` CLI binary with stdin/stdout JSON.
`;

test('passes with inline bug description (3 template fields, feat: prefix)', () => {
  assert.equal(checkLinkedIssue(BUG_INLINE_BODY, 'feat: fix login button').passed, true);
});

test('passes with inline feature description (3 template fields)', () => {
  assert.equal(checkLinkedIssue(FEATURE_INLINE_BODY, 'feat: bulk tag').passed, true);
});

test('passes with inline adapter description (3 template fields)', () => {
  assert.equal(checkLinkedIssue(ADAPTER_INLINE_BODY, 'feat: gemini adapter').passed, true);
});

test('fails with only two bug template fields (below threshold)', () => {
  const body = `
## What happened?

Something broke.

## Expected behavior

It should work.
`;
  assert.equal(checkLinkedIssue(body, 'feat: fix').passed, false);
});

test('fails with a single stray template-like heading', () => {
  const body = `
This is mostly a free-form description but one heading happens to match.

## Expected behavior

Everything works.
`;
  assert.equal(checkLinkedIssue(body, 'feat: fix').passed, false);
});

test('hasInlineIssueDescription returns true for ≥3 bug fields', () => {
  assert.equal(hasInlineIssueDescription(BUG_INLINE_BODY), true);
});

test('hasInlineIssueDescription returns false for empty body', () => {
  assert.equal(hasInlineIssueDescription(''), false);
});

test('hasInlineIssueDescription accepts bolded labels with colons', () => {
  const body = `
**Problem:**
We need this.

**Proposed solution:**
Build it.

**Alternatives considered:**
None.
`;
  assert.equal(hasInlineIssueDescription(body), true);
});
