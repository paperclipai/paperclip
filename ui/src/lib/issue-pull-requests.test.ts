import type { IssueWorkProduct } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { getIssuePullRequests, pullRequestHref, pullRequestLabel, pullRequestNeedsReview } from "./issue-pull-requests";

function product(overrides: Partial<IssueWorkProduct> = {}): IssueWorkProduct {
  return {
    id: "pr-1", type: "pull_request", title: "Update runtime probe", url: null,
    status: "ready_for_review", reviewState: "needs_board_review", isPrimary: true,
    metadata: { url: "https://github.com/example/private-repo/pull/42" },
    updatedAt: new Date("2026-10-06T12:00:00Z"), ...overrides,
  } as IssueWorkProduct;
}

describe("saved issue pull requests", () => {
  it("keeps a private PR inspectable from its saved metadata without a provider lookup", () => {
    const saved = product();
    expect(pullRequestHref(saved)).toBe("https://github.com/example/private-repo/pull/42");
    expect(pullRequestLabel(saved)).toBe("example/private-repo#42");
    expect(pullRequestNeedsReview(saved)).toBe(true);
  });

  it.each(["merged", "closed", "archived"])("does not ask for review of %s work even with a stale review flag", (state) => {
    expect(pullRequestNeedsReview(product({ status: state }))).toBe(false);
    expect(pullRequestNeedsReview(product({ metadata: { state } }))).toBe(false);
  });

  it("keeps the newer merged record instead of an old duplicate review request", () => {
    const old = product({ id: "old", updatedAt: new Date("2026-10-05T12:00:00Z") });
    const merged = product({ status: "merged" });
    expect(getIssuePullRequests([old, merged])).toEqual([merged]);
  });

  it.each(["?diff=split", "#discussion_r123", "/files", "/"])("deduplicates GitHub navigation variants: %s", (suffix) => {
    const old = product({ id: "old", updatedAt: new Date("2026-10-05T12:00:00Z") });
    const merged = product({ status: "merged", url: `https://github.com/Example/Private-Repo/pull/42${suffix}` });
    expect(getIssuePullRequests([old, merged])).toEqual([merged]);
    expect(pullRequestHref(merged)).toBe(merged.url);
  });

  it("puts actionable reviews before historical PRs and ignores other work products", () => {
    const review = product();
    const merged = product({ id: "merged", url: "https://github.com/example/repo/pull/12", status: "merged" });
    expect(getIssuePullRequests([merged, product({ type: "artifact" }), review])).toEqual([review, merged]);
    expect(pullRequestNeedsReview(product({ reviewState: "none" }))).toBe(false);
  });

  it.each(["javascript:alert(1)", "https://token@github.com/example/repo/pull/42", "not a URL"])("does not turn an unsafe saved URL into a link: %s", (url) => {
    expect(pullRequestHref(product({ metadata: { url } }))).toBeNull();
    expect(getIssuePullRequests([product({ metadata: { url } })])).toHaveLength(1);
  });
});
