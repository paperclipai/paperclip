import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkTemplate } from '../check-pr-template.mjs';

const VALID_BODY = `
## Thinking Path
First I considered the root cause of the bug in the cursor logic. Then I traced the execution path through the pagination code. Finally I identified that the date binding was missing a toISOString call.

## What Changed
- Added .toISOString() call before binding anchor.createdAt to the postgres query

## Verification
Run pnpm test:run:general and verify the cursor pagination tests pass.

## Risks
Low risk — isolated change to one query parameter.

## Model Used
Claude Sonnet 4.5, 200k context window, extended thinking enabled, tool use: read/edit files
`;

test('passes with valid full template', () => {
  const result = checkTemplate(VALID_BODY);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('fails when Thinking Path section is missing', () => {
  const body = VALID_BODY.replace('## Thinking Path', '## Removed');
  const result = checkTemplate(body);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('Thinking Path')));
});

test('fails when Thinking Path has fewer than 3 sentences', () => {
  const body = VALID_BODY.replace(
    /## Thinking Path\n[\s\S]*?\n## What Changed/,
    '## Thinking Path\nOnly one sentence here.\n\n## What Changed'
  );
  const result = checkTemplate(body);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('Thinking Path') && f.includes('sentence')));
});

test('passes Thinking Path written as a bullet list without terminal punctuation', () => {
  const body = VALID_BODY.replace(
    /## Thinking Path\n[\s\S]*?\n## What Changed/,
    `## Thinking Path
- First point about the root cause of the bug
- Second point about how the fix addresses it
- Third point about why this approach was chosen

## What Changed`
  );
  const result = checkTemplate(body);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('passes Thinking Path written as a blockquoted bullet list', () => {
  const body = VALID_BODY.replace(
    /## Thinking Path\n[\s\S]*?\n## What Changed/,
    `## Thinking Path
> - First point in a blockquote
> - Second point in a blockquote
> - Third point in a blockquote

## What Changed`
  );
  const result = checkTemplate(body);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('passes Thinking Path written as multiple paragraphs without terminal punctuation', () => {
  const body = VALID_BODY.replace(
    /## Thinking Path\n[\s\S]*?\n## What Changed/,
    `## Thinking Path
First paragraph explaining the situation in detail

Second paragraph explaining the chosen approach in detail

Third paragraph explaining the tradeoffs in detail

## What Changed`
  );
  const result = checkTemplate(body);
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
});

test('fails when Model Used section is missing', () => {
  const body = VALID_BODY.replace('## Model Used', '## Removed');
  const result = checkTemplate(body);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('Model Used')));
});

test('fails when Model Used contains placeholder text', () => {
  const body = VALID_BODY.replace(
    /## Model Used\n[\s\S]*/,
    '## Model Used\nprovider, model id/version, context window, reasoning mode, tool use'
  );
  const result = checkTemplate(body);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('Model Used') && f.includes('placeholder')));
});

test('fails when What Changed section is empty', () => {
  const body = VALID_BODY.replace(
    /## What Changed\n[\s\S]*?\n## Verification/,
    '## What Changed\n\n## Verification'
  );
  const result = checkTemplate(body);
  assert.equal(result.passed, false);
  assert.ok(result.failures.some(f => f.includes('What Changed')));
});

test('returns multiple failures at once', () => {
  const result = checkTemplate('');
  assert.equal(result.passed, false);
  assert.ok(result.failures.length >= 5);
});
