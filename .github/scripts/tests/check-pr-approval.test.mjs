import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateApprovalGate, latestReviewStateByUser } from '../check-pr-approval.mjs';

test('latestReviewStateByUser keeps the latest review state per user', () => {
  const latest = latestReviewStateByUser([
    { user: { login: 'ross' }, state: 'APPROVED' },
    { user: { login: 'ross' }, state: 'CHANGES_REQUESTED' },
  ]);
  assert.equal(latest.get('ross'), 'CHANGES_REQUESTED');
});

test('evaluateApprovalGate rejects PRs with no reviews', () => {
  const result = evaluateApprovalGate({ reviews: [], author: 'author' });
  assert.equal(result.passed, false);
  assert.match(result.reason, /No non-author approval/);
});

test('evaluateApprovalGate rejects self-approval only', () => {
  const result = evaluateApprovalGate({
    author: 'author',
    reviews: [{ user: { login: 'author' }, state: 'APPROVED' }],
  });
  assert.equal(result.passed, false);
  assert.match(result.reason, /self-approval/);
});

test('evaluateApprovalGate accepts a non-author approval', () => {
  const result = evaluateApprovalGate({
    author: 'author',
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED' }],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.approvers, ['reviewer']);
});

test('evaluateApprovalGate accepts a non-author approval on the current head SHA', () => {
  const result = evaluateApprovalGate({
    author: 'author',
    headSha: 'abc123',
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'abc123' }],
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.approvers, ['reviewer']);
});

test('evaluateApprovalGate rejects stale approvals from a previous head SHA', () => {
  const result = evaluateApprovalGate({
    author: 'author',
    headSha: 'new-head',
    reviews: [{ user: { login: 'reviewer' }, state: 'APPROVED', commit_id: 'old-head' }],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.staleApprovals, ['reviewer']);
  assert.match(result.reason, /stale/);
});

test('evaluateApprovalGate rejects active changes-requested reviews', () => {
  const result = evaluateApprovalGate({
    author: 'author',
    reviews: [
      { user: { login: 'reviewer' }, state: 'APPROVED' },
      { user: { login: 'security' }, state: 'CHANGES_REQUESTED' },
    ],
  });
  assert.equal(result.passed, false);
  assert.match(result.reason, /Changes requested/);
});
