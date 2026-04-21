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
      latestAssigneeCommentAgeMs?: number | null;
      latestRunStatus?: string | null | undefined;
      latestRunFinishedAt?: Date | null;
      hasRecentValidQaVerdict?: boolean;
      nowMs?: number;
    }) => boolean;
  }
).shouldSuppressOperationsRecoveryTarget;

const getOperationsRecoverySuppressionReason = (
  heartbeat as {
    getOperationsRecoverySuppressionReason?: (input: {
      status: string;
      latestCommentBody: string | null | undefined;
      latestCommentAgeHours: number;
      hasBlockers: boolean;
      latestAssigneeCommentAgeMs?: number | null;
      latestRunStatus?: string | null | undefined;
      latestRunFinishedAt?: Date | null;
      hasRecentValidQaVerdict?: boolean;
      nowMs?: number;
    }) => string | null;
  }
).getOperationsRecoverySuppressionReason;

const isMeaningfulRecoveryActivityComment = (
  heartbeat as {
    isMeaningfulRecoveryActivityComment?: (comment: {
      body: string | null | undefined;
      authorAgentId?: string | null;
      createdByRunId?: string | null;
    }) => boolean;
  }
).isMeaningfulRecoveryActivityComment;

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

  it("suppresses recovery for fresh workflow-gated completion truth", () => {
    expect(shouldSuppressOperationsRecoveryTarget?.({
      status: "in_progress",
      latestCommentBody: [
        "DONE: Fix already verified and committed.",
        "Workflow gate: requires QA assignee before entering in_review.",
        "Missing permission: tasks:assign.",
        "Board action required.",
      ].join("\n"),
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

  it("suppresses recovery when the latest successful run finished within the short activity cooldown", () => {
    const nowMs = Date.now();
    expect(getOperationsRecoverySuppressionReason?.({
      status: "in_progress",
      latestCommentBody: null,
      latestCommentAgeHours: Number.POSITIVE_INFINITY,
      hasBlockers: false,
      latestRunStatus: "completed",
      latestRunFinishedAt: new Date(nowMs - 5 * 60 * 1000),
      nowMs,
    })).toBe("recent successful run still within recovery cooldown");
  });

  it("suppresses recovery when a recent assignee comment landed within the short activity cooldown", () => {
    expect(getOperationsRecoverySuppressionReason?.({
      status: "blocked",
      latestCommentBody: "I am validating the last run output now.",
      latestCommentAgeHours: 0,
      latestAssigneeCommentAgeMs: 3 * 60 * 1000,
      hasBlockers: true,
    })).toBe("recent assignee issue activity still within recovery cooldown");
  });

  it("does not suppress recovery when the recent comment is not from the assignee lane", () => {
    expect(getOperationsRecoverySuppressionReason?.({
      status: "blocked",
      latestCommentBody: "PM asked for another update.",
      latestCommentAgeHours: 0,
      hasBlockers: true,
    })).toBe(null);
  });

  it("suppresses recovery when a fresh valid QA verdict already exists", () => {
    expect(getOperationsRecoverySuppressionReason?.({
      status: "in_review",
      latestCommentBody: [
        "DONE: Checkout release gate validation is complete.",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
      latestCommentAgeHours: 0,
      hasBlockers: false,
      hasRecentValidQaVerdict: true,
    })).toBe("fresh valid QA verdict exists");
  });

  it("ignores transcript-only assignee activity comments", () => {
    expect(isMeaningfulRecoveryActivityComment?.({
      authorAgentId: "agent-1",
      createdByRunId: "run-1",
      body: "↻ Resumed session\nSession abc123 found but has no messages. Starting fresh...",
    })).toBe(false);
  });

  it("keeps genuine assignee progress comments meaningful", () => {
    expect(isMeaningfulRecoveryActivityComment?.({
      authorAgentId: "agent-1",
      createdByRunId: "run-1",
      body: "I am validating the last run output and will post issue truth next.",
    })).toBe(true);
  });

  it("ignores incidental transcript-style prose when deciding whether recent assignee activity should suppress recovery", () => {
    expect(isMeaningfulRecoveryActivityComment?.({
      authorAgentId: "agent-1",
      body: [
        "Working on issue e2ddfdb4-3d86-4a68-b551-f214305c14c7 — Cart UX trust audit QA gate.",
        "The API still rejects patch requests because of a stale execution lock and a missing permission error from a prior session.",
        "I will inspect what should happen before entering in_review once the lock is cleared.",
      ].join("\n"),
    })).toBe(false);
  });
});
