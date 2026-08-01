import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

// Prose-only description (no template labels) must fail. A good paragraph of
// prose matches zero labels, so the gate rejects it.
test('fails with a prose-only description that has no template labels', () => {
  const body = `
This pull request rewrites the retry loop so the worker gives up after five
attempts instead of looping forever. The previous loop could hang a job when
the upstream service was down. I also added a log line for each retry so an
operator can see the backoff in the run output.
`;
  const result = checkLinkedIssue(body, 'feat: bounded retry');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

// An author who copies the feature template labels into the PR body must pass.
// The labels use the bold-label-on-its-own-line form the gate accepts.
const FEATURE_BOLD_LABEL_BODY = `
**Problem or motivation:**
- The gate rejects a good prose description.

**Proposed solution:**
- Copy the feature template labels into the PR body.

**Alternatives considered:**
- Lower the field threshold — rejected, it weakens the gate.
`;

test('passes with the feature template labels (bold labels)', () => {
  assert.equal(checkLinkedIssue(FEATURE_BOLD_LABEL_BODY, 'feat: inline feature description').passed, true);
});

// Enhancement template set (matches .github/ISSUE_TEMPLATE/enhancement.yml).
const ENHANCEMENT_INLINE_BODY = `
## What existing behavior does this improve?

The board task list sort order.

## Current behavior

The list sorts by creation time only.

## Proposed behavior

The list sorts by priority, then creation time.

## Reason and benefit

Users miss high-priority tasks that were created early.
`;

test('passes with inline enhancement description (4 template fields)', () => {
  assert.equal(checkLinkedIssue(ENHANCEMENT_INLINE_BODY, 'feat: sort by priority').passed, true);
});

test('hasInlineIssueDescription returns true for ≥3 enhancement fields', () => {
  assert.equal(hasInlineIssueDescription(ENHANCEMENT_INLINE_BODY), true);
});

// Empty default skeleton must fail. A label with only the bare "-" placeholder
// under it is not filled, so it must not count toward the field minimum.
const EMPTY_SKELETON_BODY = `
**What happened?**
-

**Expected behavior:**
-

**Steps to reproduce:**
-
`;

test('fails with an empty template skeleton (labels but no content)', () => {
  const result = checkLinkedIssue(EMPTY_SKELETON_BODY, 'feat: something');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length > 0);
});

test('hasInlineIssueDescription returns false for an empty skeleton', () => {
  assert.equal(hasInlineIssueDescription(EMPTY_SKELETON_BODY), false);
});

// A filled bug skeleton in the bold-label form must pass, even with list-marker
// content. This proves the fix does not reject real author content.
const FILLED_BUG_SKELETON_BODY = `
**What happened?**
- The login button does nothing.

**Expected behavior:**
- The login button authenticates the user.

**Steps to reproduce:**
- Open the app, then click login.
`;

test('passes with a filled bug skeleton (three filled fields)', () => {
  assert.equal(checkLinkedIssue(FILLED_BUG_SKELETON_BODY, 'feat: fix login').passed, true);
});

// Stacked plain labels with no content must fail. Each label sits on its own
// line with the next label directly under it. The scan must treat the next
// label as a field boundary, not as content, so every field stays empty.
const STACKED_FEATURE_LABELS = `
Problem or motivation:
Proposed solution:
Alternatives considered:
Roadmap alignment:
`;

const STACKED_BUG_LABELS = `
What happened?:
Expected behavior:
Steps to reproduce:
Paperclip version:
`;

const STACKED_ENHANCEMENT_LABELS = `
What existing behavior does this improve?
Subsystem affected
Current behavior
Proposed behavior
Reason and benefit
`;

const STACKED_DOCS_LABELS = `
Issue type
Where is the issue?
What's wrong?
Suggested fix
`;

test('fails with stacked plain feature labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_FEATURE_LABELS, 'feat: x').passed, false);
});

test('fails with stacked plain bug labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_BUG_LABELS, 'feat: x').passed, false);
});

test('fails with stacked plain enhancement labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_ENHANCEMENT_LABELS, 'feat: x').passed, false);
});

test('fails with stacked plain docs labels and no content', () => {
  assert.equal(checkLinkedIssue(STACKED_DOCS_LABELS, 'feat: x').passed, false);
});

// A plain-label skeleton with real content under each label must still pass.
// The boundary fix must not reject a field that has genuine content.
const FILLED_PLAIN_FEATURE_LABELS = `
Problem or motivation:
- The gate rejects a good prose description.
Proposed solution:
- Copy the feature template labels into the PR body.
Alternatives considered:
- Lower the field threshold — rejected, it weakens the gate.
`;

test('passes with plain feature labels and real content under each', () => {
  assert.equal(checkLinkedIssue(FILLED_PLAIN_FEATURE_LABELS, 'feat: inline feature').passed, true);
});

// The real .github/PULL_REQUEST_TEMPLATE.md, submitted unchanged, must fail the
// gate. Its skeleton labels have no content and its example issue links live in
// HTML comments, so neither the inline path nor the linked path may pass it.
const PR_TEMPLATE_PATH = fileURLToPath(
  new URL('../../PULL_REQUEST_TEMPLATE.md', import.meta.url)
);

test('fails with the unfilled default PR template body', () => {
  const body = readFileSync(PR_TEMPLATE_PATH, 'utf8');
  const result = checkLinkedIssue(body, 'feat: unfilled template');
  assert.equal(result.passed, false);
});

// An issue link that appears only inside an HTML comment must not satisfy the
// linked-issue check. The template ships such an example ("Fixes: #123").
test('fails when the only issue link is inside an HTML comment', () => {
  const body = '<!-- Example: Fixes: #123 -->\n\nSome prose with no real link.';
  assert.equal(checkLinkedIssue(body, 'feat: commented link').passed, false);
});
