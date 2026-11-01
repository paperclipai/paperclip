import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRiskTier, RISK_LABELS } from '../check-pr-risk-tier.mjs';

const BASE_BODY = `
## Thinking Path
> - One
> - Two
> - Three

## What Changed
- Example change

## Verification
- Ran unit tests

## Risks
Low risk — docs only.

## Model Used
None — human-authored
`;

test('fails when risk tier is missing', () => {
  const result = checkRiskTier({ body: BASE_BODY, labels: [] });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('Missing risk tier')));
});

test('passes with risk:low label', () => {
  const result = checkRiskTier({
    body: BASE_BODY,
    labels: [{ name: RISK_LABELS.low }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.tier, 'low');
  assert.ok(result.informational.some((i) => /1 reviewer/i.test(i)));
});

test('passes with body Risk tier declaration when labels absent', () => {
  const body = BASE_BODY.replace(
    '## Risks\nLow risk — docs only.',
    '## Risks\nRisk tier: medium\nBehaviour change in internal API; covered by unit tests.'
  );
  const result = checkRiskTier({ body, labels: [] });
  assert.equal(result.passed, true);
  assert.equal(result.tier, 'medium');
  assert.ok(result.informational.some((i) => /Prefer applying the GitHub label/i.test(i)));
});

test('fails when multiple risk labels are applied', () => {
  const result = checkRiskTier({
    body: BASE_BODY,
    labels: [{ name: 'risk:low' }, { name: 'risk:high' }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('Multiple risk-tier labels')));
});

test('fails when label and body disagree', () => {
  const body = `${BASE_BODY}\n\nRisk tier: high\n`;
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:low' }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => f.includes('disagrees')));
});

test('high risk fails without rollback plan', () => {
  const result = checkRiskTier({
    body: BASE_BODY,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => /rollback plan/i.test(f)));
});

test('high risk passes with Rollback Plan section', () => {
  const body = `${BASE_BODY}

## Rollback Plan
Revert this PR and redeploy the previous release tag. No data migration to undo.
`;
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.tier, 'high');
  assert.ok(result.informational.some((i) => /2 approvals/i.test(i)));
});

test('high risk passes when Risks section documents rollback plan', () => {
  const body = BASE_BODY.replace(
    '## Risks\nLow risk — docs only.',
    `## Risks
High risk auth change.
Rollback plan: revert the PR and clear the feature flag \`auth.v2\`; no irreversible migration.`
  );
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, true);
});

test('warns when paths look higher risk than declared tier', () => {
  const result = checkRiskTier({
    body: BASE_BODY,
    labels: [{ name: 'risk:low' }],
    files: [{ filename: 'packages/db/src/migrations/0099_example.sql' }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.inferredTier, 'high');
  assert.ok(result.informational.some((i) => /look like \*\*high\*\* risk/i.test(i)));
});

test('accepts risk-high alias label form', () => {
  const body = `${BASE_BODY}

## Rollback Plan
Roll back by reverting the merge commit on master and re-running the prior deploy workflow.
`;
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk-high' }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.tier, 'high');
});

test('high risk fails on checkbox-only rollback claim', () => {
  const body = `${BASE_BODY}

- [x] rollback plan attached
`;
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => /rollback plan/i.test(f)));
});

test('high risk fails on negation prose under Risks', () => {
  const body = BASE_BODY.replace(
    '## Risks\nLow risk — docs only.',
    `## Risks
High risk change.
No rollback plan is needed because this is a forward-only schema tweak with no prior state.`
  );
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => /rollback plan/i.test(f)));
});

test('high risk passes when HTML hint comment precedes real Rollback Plan content', () => {
  const body = `${BASE_BODY}

## Rollback Plan
<!-- Describe how to undo this change if something goes wrong. -->
Revert this PR and redeploy the previous release tag. No data migration to undo.
`;
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.tier, 'high');
});

test('does not infer high risk from author.ts or oauth-notes paths', () => {
  const result = checkRiskTier({
    body: BASE_BODY,
    labels: [{ name: 'risk:low' }],
    files: [
      { filename: 'ui/src/lib/author.ts' },
      { filename: 'doc/notes/oauth-notes.md' },
    ],
  });
  assert.equal(result.passed, true);
  assert.equal(result.inferredTier, 'low');
  assert.ok(!result.informational.some((i) => /look like \*\*high\*\* risk/i.test(i)));
});

test('still infers high risk from auth path segments', () => {
  const result = checkRiskTier({
    body: BASE_BODY,
    labels: [{ name: 'risk:low' }],
    files: [{ filename: 'packages/shared/src/auth/session.ts' }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.inferredTier, 'high');
  assert.ok(result.informational.some((i) => /look like \*\*high\*\* risk/i.test(i)));
});

test('high risk passes when Risks prose contains distant not before rollback plan', () => {
  const body = BASE_BODY.replace(
    '## Risks\nLow risk — docs only.',
    `## Risks
High risk change. Do not skip verification.
Rollback plan: revert the PR and redeploy the previous release tag immediately.`
  );
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.tier, 'high');
});

test('high risk passes when Risks prose contains distant without before rollback plan', () => {
  const body = BASE_BODY.replace(
    '## Risks\nLow risk — docs only.',
    `## Risks
Deploy without downtime.
Rollback plan: revert the PR and redeploy the previous release tag immediately.`
  );
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, true);
  assert.equal(result.tier, 'high');
});

test('high risk fails on immediate No rollback plan colon form under Risks', () => {
  const body = BASE_BODY.replace(
    '## Risks\nLow risk — docs only.',
    `## Risks
High risk change.
No rollback plan: this is intentionally irreversible after the cutover window closes.`
  );
  const result = checkRiskTier({
    body,
    labels: [{ name: 'risk:high' }],
  });
  assert.equal(result.passed, false);
  assert.ok(result.failures.some((f) => /rollback plan/i.test(f)));
});
