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

test('commitperclip gates are skipped when the app key is unavailable', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const tokenCheckStep = workflow.match(
    /- name: Check commitperclip token availability[\s\S]*?(?=\n\s*- name:|\n\s*jobs:|\n?$)/
  )?.[0];

  assert.ok(tokenCheckStep, 'workflow should check for COMMITPERCLIP_KEY before generating a token');
  assert.match(tokenCheckStep, /available=false/);
  assert.match(tokenCheckStep, /COMMITPERCLIP_KEY:\s*\$\{\{\s*secrets\.COMMITPERCLIP_KEY\s*\}\}/);

  for (const stepName of [
    'Generate commitperclip token',
    'Run quality gates',
    'Run security gates',
  ]) {
    const step = workflow.match(new RegExp(`- name: ${stepName}[\\s\\S]*?(?=\\n\\s*- name:|\\n\\s*jobs:|\\n?$)`))?.[0];
    assert.ok(step, `${stepName} step should exist`);
    assert.match(step, /if:\s*steps\.commitperclip-key\.outputs\.available == 'true'/);
  }

  const failStep = workflow.match(
    /- name: Fail if quality gates failed[\s\S]*?(?=\n\s*- name:|\n\s*jobs:|\n?$)/
  )?.[0];
  assert.ok(failStep, 'quality failure step should exist');
  assert.match(
    failStep,
    /if:\s*steps\.commitperclip-key\.outputs\.available == 'true' && steps\.quality\.outcome == 'failure'/
  );
});
