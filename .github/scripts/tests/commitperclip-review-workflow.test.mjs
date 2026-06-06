import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workflowPath = new URL('../../workflows/commitperclip-review.yml', import.meta.url);

test('commitperclip review checks out the pull request base branch', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(
    workflow,
    /ref:\s*\$\{\{\s*github\.event\.pull_request\.base\.ref\s*\}\}/,
    'pull_request_target must check out the base branch, not a hardcoded branch or PR code'
  );
  assert.doesNotMatch(workflow, /ref:\s*master\b/);
});

test('dependency review uses pull_request_target event refs', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const dependencyReviewStep = workflow.match(
    /- name: Dependency Review[\s\S]*?(?=\n\s*- name:|\n\s*jobs:|\n?$)/
  )?.[0];

  assert.ok(dependencyReviewStep, 'Dependency Review step should exist');
  assert.doesNotMatch(dependencyReviewStep, /\bbase-ref:/);
  assert.doesNotMatch(dependencyReviewStep, /\bhead-ref:/);
  assert.match(dependencyReviewStep, /\bcontinue-on-error:\s*true\b/);
  assert.match(dependencyReviewStep, /\bid:\s*dependency-review\b/);
});
