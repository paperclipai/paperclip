import type { IssueWorkProduct } from "@paperclipai/shared";
import { workProductHref } from "./issue-artifacts";

const TERMINAL_STATES = new Set(["merged", "closed", "archived"]);

export function pullRequestState(product: IssueWorkProduct): string {
  if (TERMINAL_STATES.has(product.status)) return product.status;
  return typeof product.metadata?.state === "string" ? product.metadata.state : product.status;
}

export function pullRequestNeedsReview(product: IssueWorkProduct): boolean {
  const state = pullRequestState(product);
  return !TERMINAL_STATES.has(state)
    && state !== "changes_requested"
    && product.reviewState === "needs_board_review";
}

export function pullRequestHref(product: IssueWorkProduct): string | null {
  const href = workProductHref(product);
  if (!href) return null;
  try {
    const url = new URL(href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function pullRequestLabel(product: IssueWorkProduct): string {
  const href = pullRequestHref(product);
  if (href) {
    const url = new URL(href);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (url.hostname === "github.com" && match) return `${match[1]}/${match[2]}#${match[3]}`;
  }
  return product.title;
}

/** GitHub navigation options and comment anchors do not identify a different PR. */
export function pullRequestIdentity(href: string | null | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (url.hostname === "github.com" && !url.port && match) {
      return `github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${Number(match[3])}`;
    }
    return url.href;
  } catch {
    return null;
  }
}

/** Prefer the newest saved record when an agent registered the same PR twice. */
export function getIssuePullRequests(products: IssueWorkProduct[] | null | undefined): IssueWorkProduct[] {
  const sorted = (products ?? []).filter((product) => product.type === "pull_request")
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      || Number(TERMINAL_STATES.has(pullRequestState(b))) - Number(TERMINAL_STATES.has(pullRequestState(a))));
  const seen = new Set<string>();
  return sorted.filter((product) => {
    const key = pullRequestIdentity(pullRequestHref(product)) ?? product.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(pullRequestNeedsReview(b)) - Number(pullRequestNeedsReview(a))
    || Number(b.isPrimary) - Number(a.isPrimary));
}
