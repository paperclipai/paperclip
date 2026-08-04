import { describe, expect, it } from "vitest";
import { isIssueProductivityReviewOriginKind } from "./constants.js";

describe("isIssueProductivityReviewOriginKind", () => {
  it("returns true only for the literal 'issue_productivity_review'", () => {
    expect(isIssueProductivityReviewOriginKind("issue_productivity_review")).toBe(true);
  });

  it("returns false for other built-in origin kinds", () => {
    expect(isIssueProductivityReviewOriginKind("manual")).toBe(false);
    expect(isIssueProductivityReviewOriginKind("routine_execution")).toBe(false);
    expect(isIssueProductivityReviewOriginKind("stranded_issue_recovery")).toBe(false);
    expect(isIssueProductivityReviewOriginKind("stale_active_run_evaluation")).toBe(false);
    expect(isIssueProductivityReviewOriginKind("harness_liveness_escalation")).toBe(false);
  });

  it("returns false for plugin origin kinds", () => {
    expect(isIssueProductivityReviewOriginKind("plugin:my-plugin:operation")).toBe(false);
  });

  it("returns false for null and undefined", () => {
    expect(isIssueProductivityReviewOriginKind(null)).toBe(false);
    expect(isIssueProductivityReviewOriginKind(undefined)).toBe(false);
  });

  it("returns false for empty string and partial matches", () => {
    expect(isIssueProductivityReviewOriginKind("")).toBe(false);
    expect(isIssueProductivityReviewOriginKind("productivity_review")).toBe(false);
    expect(isIssueProductivityReviewOriginKind("issue_productivity")).toBe(false);
  });
});
