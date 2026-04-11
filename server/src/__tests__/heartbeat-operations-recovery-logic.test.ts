import { describe, expect, it } from "vitest";
import * as heartbeat from "../services/heartbeat.ts";

const classifyIssueTruthFromCommentBody = (
  heartbeat as { classifyIssueTruthFromCommentBody?: (body: string | null | undefined) => string | null }
).classifyIssueTruthFromCommentBody;

const shouldSuppressOperationsRecoveryTarget = (
  heartbeat as {
    shouldSuppressOperationsRecoveryTarget?: (input: {
      status: string;
      latestCommentBody: string | null | undefined;
      latestCommentAgeHours: number;
      hasBlockers: boolean;
    }) => boolean;
  }
).shouldSuppressOperationsRecoveryTarget;

describe("heartbeat operations recovery logic", () => {
  it("classifies markdown blocked headings as blocker truth", () => {
    expect(classifyIssueTruthFromCommentBody?.("## Blocked On Missing Inputs")).toBe("blocker");
  });

  it("classifies reassigned headings as handoff truth", () => {
    expect(classifyIssueTruthFromCommentBody?.("## Reassigned To COO For POS Export Access")).toBe("handoff");
  });

  it("suppresses recovery for blocked issues with fresh blocker truth and first-class blockers", () => {
    expect(shouldSuppressOperationsRecoveryTarget?.({
      status: "blocked",
      latestCommentBody: "## Blocked On Missing Inputs",
      latestCommentAgeHours: 0,
      hasBlockers: true,
    })).toBe(true);
  });

  it("suppresses recovery for in-progress issues with fresh handoff truth", () => {
    expect(shouldSuppressOperationsRecoveryTarget?.({
      status: "in_progress",
      latestCommentBody: "## Reassigned To COO For POS Export Access",
      latestCommentAgeHours: 0,
      hasBlockers: false,
    })).toBe(true);
  });

  it("does not suppress recovery for stale blocked issues without blocker truth or blockers", () => {
    expect(shouldSuppressOperationsRecoveryTarget?.({
      status: "blocked",
      latestCommentBody: "Working on it",
      latestCommentAgeHours: 12,
      hasBlockers: false,
    })).toBe(false);
  });
});
