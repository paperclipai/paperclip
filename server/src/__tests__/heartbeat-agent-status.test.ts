import { describe, expect, it } from "vitest";
import {
  buildGoalAwareIssueCloseoutProof,
  buildIssueWakeCooldownStateFingerprint,
  classifyAdapterHeartbeatOutcome,
  deriveAgentStatusFromActiveRunCounts,
} from "../services/heartbeat.ts";

describe("deriveAgentStatusFromActiveRunCounts", () => {
  it("treats queued work as active agent work", () => {
    expect(
      deriveAgentStatusFromActiveRunCounts({
        queuedCount: 1,
        runningCount: 0,
        outcome: "failed",
      }),
    ).toBe("running");
  });

  it("treats running work as active agent work", () => {
    expect(
      deriveAgentStatusFromActiveRunCounts({
        queuedCount: 0,
        runningCount: 1,
        outcome: "failed",
      }),
    ).toBe("running");
  });

  it("falls back to idle after a successful outcome with no active runs", () => {
    expect(
      deriveAgentStatusFromActiveRunCounts({
        queuedCount: 0,
        runningCount: 0,
        outcome: "succeeded",
      }),
    ).toBe("idle");
  });

  it("falls back to error after a failed outcome with no active runs", () => {
    expect(
      deriveAgentStatusFromActiveRunCounts({
        queuedCount: 0,
        runningCount: 0,
        outcome: "failed",
      }),
    ).toBe("error");
  });
});

describe("classifyAdapterHeartbeatOutcome", () => {
  it("marks provider auth text inside an otherwise clean adapter result as a logical failure", () => {
    expect(
      classifyAdapterHeartbeatOutcome({
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: {
          summary: "Final error: HTTP 401: unauthorized: invalid api key",
        },
      }),
    ).toMatchObject({
      outcome: "failed",
      status: "failed",
      errorCode: "provider_logical_failure",
      logicalFailure: "HTTP 401: unauthorized: invalid api key",
    });
  });

  it("marks structured provider failed attempts as logical failures", () => {
    expect(
      classifyAdapterHeartbeatOutcome({
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: {
          failed_attempts: [
            {
              model: "deepseek/deepseek-chat-v3.1:free",
              provider: "openrouter",
              message: "HTTP 429: Rate limit exceeded: free-models-per-min.",
            },
          ],
        },
      }),
    ).toMatchObject({
      outcome: "failed",
      status: "failed",
      errorCode: "provider_logical_failure",
      logicalFailure: "HTTP 429: Rate limit exceeded: free-models-per-min.",
    });
  });

  it("does not scan raw stdout/stderr transcripts as terminal provider failures", () => {
    expect(
      classifyAdapterHeartbeatOutcome({
        exitCode: 0,
        signal: null,
        timedOut: false,
        resultJson: {
          stdout: `
            {"type":"item.completed","item":{"type":"command_execution","aggregated_output":"const authError = formState.error;"}}
            {"ts":"2026-05-10T14:25:57.743Z","stream":"stderr","chunk":"ERROR codex_core::session: failed to record rollout items: thread not found"}
          `,
          stderr: "ERROR codex_core::session: failed to record rollout items: thread not found",
        },
        summary: "The issue remains blocked; I left a proof-bearing blocked closeout comment.",
      }),
    ).toMatchObject({
      outcome: "succeeded",
      status: "succeeded",
      errorCode: null,
      logicalFailure: null,
    });
  });

  it("does not treat business-context quota language as a provider terminal failure", () => {
    expect(
      classifyAdapterHeartbeatOutcome({
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary:
          "The issue remains blocked on upstream Gemini/deep-research quota/input capacity, not a WebApp-side code defect.",
        resultJson: {
          stdout: "Current blocker: upstream Gemini/deep-research quota/input capacity.",
        },
      }),
    ).toMatchObject({
      outcome: "succeeded",
      status: "succeeded",
      errorCode: null,
      logicalFailure: null,
    });
  });
});

describe("buildIssueWakeCooldownStateFingerprint", () => {
  it("treats rapid no-change agent comments as the same wake state", () => {
    const first = buildIssueWakeCooldownStateFingerprint(
      { issueId: "issue-1", commentId: "comment-a", mutation: "comment" },
      { issueId: "issue-1", source: "issue.comment", wakeReason: "issue_commented" },
    );
    const second = buildIssueWakeCooldownStateFingerprint(
      { issueId: "issue-1", commentId: "comment-b", mutation: "comment" },
      { issueId: "issue-1", source: "issue.comment", wakeReason: "issue_commented" },
    );

    expect(second).toBe(first);
  });

  it("lets materially changed issue state produce a distinct wake state", () => {
    expect(
      buildIssueWakeCooldownStateFingerprint(
        { issueId: "issue-1", mutation: "update", status: "blocked" },
        { issueId: "issue-1", source: "issue.status_change" },
      ),
    ).not.toBe(
      buildIssueWakeCooldownStateFingerprint(
        { issueId: "issue-1", mutation: "update", status: "todo" },
        { issueId: "issue-1", source: "issue.status_change" },
      ),
    );
  });
});

describe("buildGoalAwareIssueCloseoutProof", () => {
  it("blocks a non-terminal issue when a goal-aware successful run omitted durable proof", () => {
    const proof = buildGoalAwareIssueCloseoutProof({
      context: {
        paperclipCodexGoal: {
          objective: "Map issue objective into Codex prompt.",
          tokenBudget: "7000 tokens",
          timeoutSec: 1800,
          evidenceRequirements: ["Show prompt capture.", "Run the adapter test."],
        },
      },
      issue: {
        id: "issue-123",
        identifier: "BLU-123",
        title: "Goal-aware Codex",
        status: "in_progress",
      },
      runId: "run-123",
      outcome: "succeeded",
      exitCode: 0,
    });

    expect(proof?.status).toBe("blocked");
    expect(proof?.comment).toContain("Goal-aware Codex blocker proof");
    expect(proof?.comment).toContain("Run: run-123");
    expect(proof?.comment).toContain("Map issue objective into Codex prompt.");
    expect(proof?.comment).toContain("Token budget: 7000 tokens");
    expect(proof?.comment).toContain("Timeout: 1800 seconds");
    expect(proof?.comment).toContain("State claimed: blocked");
    expect(proof?.comment).toContain("Stage reached: adapter_succeeded_without_terminal_issue_closeout");
    expect(proof?.comment).toContain("Proof paths and command outputs:");
    expect(proof?.comment).toContain("Show prompt capture.");
    expect(proof?.comment).toContain("Shared state evidence checklist");
    expect(proof?.comment).toContain("awaiting_human_decision");
    expect(proof?.comment).toContain("Next action / retry condition:");
    expect(proof?.comment).toContain("Residual risk:");
    expect(proof?.comment).toContain("did not leave terminal issue proof");
  });

  it("does not overwrite a terminal done or blocked issue closeout", () => {
    expect(
      buildGoalAwareIssueCloseoutProof({
        context: {
          paperclipCodexGoal: {
            objective: "Already done.",
          },
        },
        issue: {
          id: "issue-123",
          identifier: "BLU-123",
          title: "Goal-aware Codex",
          status: "done",
        },
        runId: "run-123",
        outcome: "succeeded",
        exitCode: 0,
      }),
    ).toBeNull();

    expect(
      buildGoalAwareIssueCloseoutProof({
        context: {
          paperclipCodexGoal: {
            objective: "Already blocked.",
          },
        },
        issue: {
          id: "issue-123",
          identifier: "BLU-123",
          title: "Goal-aware Codex",
          status: "blocked",
        },
        runId: "run-123",
        outcome: "failed",
        exitCode: 1,
      }),
    ).toBeNull();
  });
});
