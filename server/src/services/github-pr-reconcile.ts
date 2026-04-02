/**
 * GitHub PR state reconciliation for pull_request work-products.
 *
 * Fetches current PR state from the GitHub API and maps it to
 * Paperclip work-product status / reviewState values.
 */

import type { IssueWorkProductStatus, IssueWorkProductReviewState } from "@paperclipai/shared";

export interface ParsedGitHubPr {
  owner: string;
  repo: string;
  number: number;
}

export interface ReconciledPrState {
  status: IssueWorkProductStatus;
  reviewState: IssueWorkProductReviewState;
}

/**
 * Extract owner, repo, and PR number from a GitHub pull request URL.
 * Supports both `https://github.com/…` and `http://github.com/…` forms.
 */
export function parseGitHubPrUrl(url: string): ParsedGitHubPr | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
}

/**
 * Fetch the current state of a GitHub PR and map it to Paperclip values.
 *
 * Uses `GITHUB_TOKEN` env-var when available (needed for private repos).
 * Falls back to unauthenticated access for public repos (60 req/hr).
 */
export async function reconcilePrState(
  parsed: ParsedGitHubPr,
): Promise<ReconciledPrState | null> {
  const token = process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "paperclip-server",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const prUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
  const prRes = await fetch(prUrl, { headers });
  if (!prRes.ok) return null;

  const pr = (await prRes.json()) as {
    merged: boolean;
    state: string;
    draft: boolean;
    requested_reviewers?: unknown[];
  };

  // Merged PR — terminal state
  if (pr.merged) {
    return { status: "merged", reviewState: "approved" };
  }

  // Closed without merge
  if (pr.state === "closed") {
    return { status: "closed", reviewState: "none" };
  }

  // Draft PR
  if (pr.draft) {
    return { status: "draft", reviewState: "none" };
  }

  // Open PR — check latest substantive review
  let reviewState: IssueWorkProductReviewState = "none";
  const reviewsUrl = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}/reviews`;
  const reviewsRes = await fetch(reviewsUrl, { headers });
  if (reviewsRes.ok) {
    const reviews = (await reviewsRes.json()) as { state: string }[];
    // Walk reviews newest-first to find the latest substantive one
    for (let i = reviews.length - 1; i >= 0; i--) {
      const s = reviews[i].state;
      if (s === "APPROVED") {
        reviewState = "approved";
        break;
      }
      if (s === "CHANGES_REQUESTED") {
        reviewState = "changes_requested";
        break;
      }
    }
  }

  // If no substantive review and reviewers are requested, mark as needs review
  if (reviewState === "none" && (pr.requested_reviewers?.length ?? 0) > 0) {
    reviewState = "needs_board_review";
  }

  return { status: "active", reviewState };
}
