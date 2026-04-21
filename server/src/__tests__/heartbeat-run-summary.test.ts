import { describe, expect, it } from "vitest";
import {
  summarizeHeartbeatRunResultJson,
  buildHeartbeatRunIssueComment,
  isLikelySynthesizedRunSummaryText,
  normalizeRunLinkedIssueCommentBody,
} from "../services/heartbeat-run-summary.js";

describe("summarizeHeartbeatRunResultJson", () => {
  it("truncates text fields and preserves cost aliases", () => {
    const summary = summarizeHeartbeatRunResultJson({
      summary: "a".repeat(600),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
      nested: { ignored: true },
    });

    expect(summary).toEqual({
      summary: "a".repeat(500),
      result: "ok",
      message: "done",
      error: "failed",
      total_cost_usd: 1.23,
      cost_usd: 0.45,
      costUsd: 0.67,
    });
  });

  it("returns null for non-object and irrelevant payloads", () => {
    expect(summarizeHeartbeatRunResultJson(null)).toBeNull();
    expect(summarizeHeartbeatRunResultJson(["nope"] as unknown as Record<string, unknown>)).toBeNull();
    expect(summarizeHeartbeatRunResultJson({ nested: { only: "ignored" } })).toBeNull();
  });
});

describe("buildHeartbeatRunIssueComment", () => {
  it("uses the final summary text for issue comments on successful runs", () => {
    const comment = buildHeartbeatRunIssueComment({
      summary: "## Summary\n\n- fixed deploy config\n- posted issue update",
    });

    expect(comment).toContain("## Summary");
    expect(comment).toContain("- fixed deploy config");
    expect(comment).not.toContain("Run summary");
  });

  it("falls back to result or message when summary is missing", () => {
    expect(buildHeartbeatRunIssueComment({ result: "done" })).toBe("done");
    expect(buildHeartbeatRunIssueComment({ message: "completed" })).toBe("completed");
  });

  it("filters command-result boilerplate out of issue comments", () => {
    expect(
      buildHeartbeatRunIssueComment({
        summary: [
          "Updated prompt budget metrics.",
          "command: pnpm vitest run server/src/__tests__/heartbeat-run-summary.test.ts",
          "status: completed",
          "exit_code: 0",
        ].join("\n"),
      }),
    ).toBe("Updated prompt budget metrics.");
  });

  it("returns null when the run already created an issue comment", () => {
    const comment = (buildHeartbeatRunIssueComment as (...args: unknown[]) => string | null)(
      { summary: "## Summary\n\n- already posted manually" },
      { hasExistingRunComment: true },
    );

    expect(comment).toBeNull();
  });

  it("collapses repeated terminal summary blocks before posting", () => {
    const repeatedBlock = [
      "Parent COMA-145 is `cancelled` (recovery successor: COMA-1107). No active parent to notify.",
      "",
      "## Summary",
      "",
      "**Implementation Complete** — COMA-145 multi-supplier checkout trust fix shipped (25 targeted tests pass).",
      "",
      "### Acceptance Criteria",
      "1. ✅ Partial failure: explicit per-supplier summary with both outcomes",
      "2. ✅ Retry only re-sends to failed suppliers (successful ones preserved)",
      "",
      "### Status: `todo`",
    ].join("\n");

    const comment = buildHeartbeatRunIssueComment({
      result: [
        repeatedBlock,
        repeatedBlock,
        "Cannot transition to `done` directly — delivery gate requires QA agent to move through `in_review`.",
      ].join("\n"),
    });

    expect(comment).toBe([
      repeatedBlock,
      "Cannot transition to `done` directly — delivery gate requires QA agent to move through `in_review`.",
    ].join("\n"));
  });

  it("returns null when there is no usable final text", () => {
    expect(buildHeartbeatRunIssueComment({ costUsd: 1.2 })).toBeNull();
  });

  it("returns null for transcript-only resumed-session chatter", () => {
    const comment = buildHeartbeatRunIssueComment({
      result: [
        "↻ Resumed session 20260421_000731_c4b4df (1 user message, 58 total messages)",
        "",
        "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
        "Let me inspect the current issue state before posting the final verdict.",
        "╰──────────────────────────────────────────────────────────────────────────────╯",
        "",
        "⚠️  DANGEROUS COMMAND: Security scan — [HIGH] Pipe to interpreter",
        "Choice [o/s/D]:       ✗ Denied",
      ].join("\n"),
    });

    expect(comment).toBeNull();
  });

  it("extracts the final verdict tail from transcript-heavy run output", () => {
    const comment = buildHeartbeatRunIssueComment({
      result: [
        "↻ Resumed session 20260421_000731_c4b4df (1 user message, 58 total messages)",
        "",
        "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
        "Let me inspect the current issue state before posting the final verdict.",
        "╰──────────────────────────────────────────────────────────────────────────────╯",
        "",
        "Smart Review Summary",
        "Root cause: locale key mismatch under cart.modeStatus.",
        "Fix: moved the keys into the cart namespace.",
        "Tests: 12/12 passing.",
        "[QA PASS]",
        "[RELEASE CONFIRMED]",
      ].join("\n"),
    });

    expect(comment).toBe([
      "Smart Review Summary",
      "Root cause: locale key mismatch under cart.modeStatus.",
      "Fix: moved the keys into the cart namespace.",
      "Tests: 12/12 passing.",
      "[QA PASS]",
      "[RELEASE CONFIRMED]",
    ].join("\n"));
  });
});

describe("normalizeRunLinkedIssueCommentBody", () => {
  it("normalizes only likely synthesized run summaries", () => {
    const repeatedSummary = [
      "Parent COMA-145 is `cancelled` (recovery successor: COMA-1107). No active parent to notify.",
      "",
      "## Summary",
      "",
      "**Implementation Complete** — COMA-145 multi-supplier checkout trust fix shipped (25 targeted tests pass).",
      "",
      "### Files Changed",
      "- assets/js/composables/useCartView.ts",
      "",
      "### Status: `todo`",
    ].join("\n");

    const repeatedPlan = [
      "Plan A",
      "1. step one with enough detail to make this line long",
      "2. step two with enough detail to make this line long",
      "3. step three with enough detail to make this line long",
      "4. step four with enough detail to make this line long",
      "Comparison: both approaches produced the same output intentionally.",
    ].join("\n");

    expect(isLikelySynthesizedRunSummaryText(repeatedSummary)).toBe(true);
    expect(isLikelySynthesizedRunSummaryText(repeatedPlan)).toBe(false);
    expect(
      normalizeRunLinkedIssueCommentBody({
        authorAgentId: "agent-1",
        createdByRunId: "run-1",
        body: [
          repeatedSummary,
          repeatedSummary,
          "Cannot transition to `done` directly — delivery gate requires QA agent to move through `in_review`.",
        ].join("\n"),
      }),
    ).toBe([
      repeatedSummary,
      "Cannot transition to `done` directly — delivery gate requires QA agent to move through `in_review`.",
    ].join("\n"));
    expect(
      normalizeRunLinkedIssueCommentBody({
        authorAgentId: "agent-1",
        createdByRunId: "run-1",
        body: `${repeatedPlan}\n${repeatedPlan}`,
      }),
    ).toBe(`${repeatedPlan}\n${repeatedPlan}`);
  });
});
