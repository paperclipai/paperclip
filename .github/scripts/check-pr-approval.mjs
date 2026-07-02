#!/usr/bin/env node
/**
 * check-pr-approval.mjs
 * Fails PRs that do not have at least one current approval from someone other
 * than the PR author. Self-approval is never sufficient.
 *
 * Env: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_HEAD_SHA
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';

export function latestReviewByUser(reviews) {
  const latest = new Map();
  for (const review of reviews ?? []) {
    const login = review?.user?.login;
    if (!login || !review?.state) continue;
    latest.set(login, {
      state: String(review.state).toUpperCase(),
      commitId: typeof review.commit_id === 'string' ? review.commit_id : null,
    });
  }
  return latest;
}

export function latestReviewStateByUser(reviews) {
  return new Map([...latestReviewByUser(reviews).entries()].map(([login, review]) => [login, review.state]));
}

export function evaluateApprovalGate({ reviews, author, headSha }) {
  const authorLogin = String(author ?? '').toLowerCase();
  const normalizedHeadSha = headSha ? String(headSha).toLowerCase() : null;
  const latest = latestReviewByUser(reviews);
  const approvers = [];
  const selfApprovals = [];
  const staleApprovals = [];
  const changesRequested = [];

  for (const [login, review] of latest.entries()) {
    const normalizedLogin = login.toLowerCase();
    if (review.state === 'CHANGES_REQUESTED') {
      changesRequested.push(login);
      continue;
    }
    if (review.state !== 'APPROVED') continue;
    if (normalizedLogin === authorLogin) {
      selfApprovals.push(login);
      continue;
    }
    if (normalizedHeadSha && review.commitId?.toLowerCase() !== normalizedHeadSha) {
      staleApprovals.push(login);
      continue;
    }
    approvers.push(login);
  }

  if (changesRequested.length > 0) {
    return {
      passed: false,
      reason: `Changes requested by: ${changesRequested.join(', ')}`,
      approvers,
      selfApprovals,
      staleApprovals,
      changesRequested,
    };
  }

  if (approvers.length === 0) {
    return {
      passed: false,
      reason: staleApprovals.length > 0
        ? `Only stale non-author approval(s) are present for a previous head commit: ${staleApprovals.join(', ')}`
        : selfApprovals.length > 0
          ? 'Only self-approval is present; at least one non-author approval is required.'
          : 'No non-author approval is present.',
      approvers,
      selfApprovals,
      staleApprovals,
      changesRequested,
    };
  }

  return {
    passed: true,
    reason: `Approved by non-author reviewer(s): ${approvers.join(', ')}`,
    approvers,
    selfApprovals,
    staleApprovals,
    changesRequested,
  };
}

async function fetchAllReviews(token, repo, prNumber, fetchFromGitHub = ghFetch) {
  const reviews = [];
  for (let page = 1; page <= 20; page += 1) {
    const batch = await fetchFromGitHub(
      `/repos/${repo}/pulls/${prNumber}/reviews?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    reviews.push(...batch);
    if (batch.length < 100) break;
  }
  return reviews;
}

async function main() {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_HEAD_SHA } = process.env;
  if (!GH_TOKEN || !GH_REPO || !PR_NUMBER || !PR_AUTHOR || !PR_HEAD_SHA) {
    console.error('ERROR: GH_TOKEN, GH_REPO, PR_NUMBER, PR_AUTHOR, PR_HEAD_SHA env vars required');
    process.exit(1);
  }
  const prNumber = Number.parseInt(PR_NUMBER, 10);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('ERROR: PR_NUMBER must be a positive integer');
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(GH_REPO)) {
    console.error('ERROR: GH_REPO must be in owner/repo format');
    process.exit(1);
  }

  const reviews = await fetchAllReviews(GH_TOKEN, GH_REPO, prNumber);
  const result = evaluateApprovalGate({ reviews, author: PR_AUTHOR, headSha: PR_HEAD_SHA });
  console.log(JSON.stringify(result));
  process.exit(result.passed ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
