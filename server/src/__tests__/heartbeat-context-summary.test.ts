import { describe, expect, it } from "vitest";
import {
  buildPaperclipTaskMarkdown,
  derivePaperclipPrReview,
  mergeCoalescedContextSnapshot,
  summarizeHeartbeatRunContextSnapshot,
  summarizeHeartbeatRunListResultJson,
} from "../services/heartbeat.js";

describe("buildPaperclipTaskMarkdown", () => {
  it("adds planning directives for assignment and comment task context", () => {
    const assignment = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
    });

    expect(assignment).toContain("- Work mode: \"planning\"");
    expect(assignment).toContain("Make the plan only. Do not write code or perform implementation work.");

    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");

    const acceptedConfirmation = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(acceptedConfirmation).toContain("Create child issues from the approved plan only");
    expect(acceptedConfirmation).not.toContain("Make the plan only.");
  });

  it("renders a GitHub PR review directive for github_pr_* wakeups", () => {
    const prReviewMarkdown = buildPaperclipTaskMarkdown({
      issue: null,
      prReview: {
        wakeReason: "github_pr_opened",
        prNumber: 35,
        repoFullName: "Blockcast/paperclip",
        event: "pull_request",
        deliveryId: "abc-123",
        reviewKind: "pr_review",
      },
    });

    expect(prReviewMarkdown).toContain('- PR: "Blockcast/paperclip#35"');
    expect(prReviewMarkdown).toContain('- Wake reason: "github_pr_opened"');
    expect(prReviewMarkdown).toContain("GitHub PR review directive:");
    expect(prReviewMarkdown).toContain("Follow your AGENTS.md PR-review workflow");
    expect(prReviewMarkdown).toContain("Do not short-circuit to an inbox check");
  });

  it("prefers ordinary comment planning guidance over stale accepted confirmation state", () => {
    const commentWake = buildPaperclipTaskMarkdown({
      issue: {
        id: "issue-1",
        identifier: "PAP-3404",
        title: "Plan first",
        workMode: "planning",
        description: null,
      },
      wakeComment: {
        id: "comment-1",
        body: "Please revise the plan.",
      },
      interaction: {
        kind: "request_confirmation",
        status: "accepted",
      },
    });

    expect(commentWake).toContain("Update the plan only. Do not write code or perform implementation work.");
    expect(commentWake).not.toContain("Create child issues from the approved plan only");
  });
});

describe("derivePaperclipPrReview", () => {
  it("returns the PR review descriptor for github_pr_* wake reasons", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
        githubEvent: "pull_request",
        githubDeliveryId: "abc-123",
        reviewKind: "pr_review",
      }),
    ).toEqual({
      wakeReason: "github_pr_opened",
      prNumber: 35,
      repoFullName: "Blockcast/paperclip",
      event: "pull_request",
      deliveryId: "abc-123",
      reviewKind: "pr_review",
    });
  });

  it("coerces string-form PR numbers (operators sometimes pass strings via curl)", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_ready_for_review",
        githubPrNumber: "42",
        githubRepoFullName: "Blockcast/paperclip",
      })?.prNumber,
    ).toBe(42);
  });

  it("returns null when no PR number is present", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "github_pr_opened",
        githubRepoFullName: "Blockcast/paperclip",
      }),
    ).toBeNull();
  });

  it("returns null when wakeReason is unrelated and reviewKind is not pr_review", () => {
    expect(
      derivePaperclipPrReview({
        wakeReason: "issue_assigned",
        githubPrNumber: 35,
      }),
    ).toBeNull();
  });

  it("matches on reviewKind even when wakeReason is missing", () => {
    expect(
      derivePaperclipPrReview({
        reviewKind: "pr_review",
        githubPrNumber: 35,
        githubRepoFullName: "Blockcast/paperclip",
      })?.wakeReason,
    ).toBe("github_pull_request");
  });
});

describe("mergeCoalescedContextSnapshot", () => {
  it("clears stale accepted-plan interaction state when merging a later ordinary comment wake", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
      {
        issueId: "issue-1",
        commentId: "comment-1",
        wakeCommentId: "comment-1",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBeUndefined();
    expect(merged.interactionKind).toBeUndefined();
    expect(merged.interactionStatus).toBeUndefined();
    expect(merged.continuationPolicy).toBeUndefined();
    expect(merged.commentId).toBe("comment-1");
    expect(merged.wakeCommentId).toBe("comment-1");
  });

  it("preserves accepted-plan interaction state for the interaction wake itself", () => {
    const merged = mergeCoalescedContextSnapshot(
      {
        issueId: "issue-1",
      },
      {
        issueId: "issue-1",
        interactionId: "interaction-1",
        interactionKind: "request_confirmation",
        interactionStatus: "accepted",
        continuationPolicy: "wake_assignee_on_accept",
        wakeReason: "issue_commented",
      },
    );

    expect(merged.interactionId).toBe("interaction-1");
    expect(merged.interactionKind).toBe("request_confirmation");
    expect(merged.interactionStatus).toBe("accepted");
    expect(merged.continuationPolicy).toBe("wake_assignee_on_accept");
  });
});

describe("summarizeHeartbeatRunContextSnapshot", () => {
  it("keeps only the small retry/linking fields needed by the client", () => {
    const summarized = summarizeHeartbeatRunContextSnapshot({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
      paperclipWake: {
        comments: [
          {
            body: "x".repeat(50_000),
          },
        ],
      },
      executionStage: {
        summary: "large nested object that should not be sent back in run lists",
      },
    });

    expect(summarized).toEqual({
      issueId: "issue-1",
      taskId: "task-1",
      taskKey: "PAP-1",
      commentId: "comment-1",
      wakeCommentId: "comment-2",
      wakeReason: "retry_failed_run",
      wakeSource: "on_demand",
      wakeTriggerDetail: "manual",
    });
  });

  it("returns null when no allowed fields are present", () => {
    expect(
      summarizeHeartbeatRunContextSnapshot({
        paperclipWake: { comments: [{ body: "hello" }] },
      }),
    ).toBeNull();
  });
});

describe("summarizeHeartbeatRunListResultJson", () => {
  it("keeps only summary fields and parses numeric cost aliases", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "Completed the task",
        result: "Updated three files",
        message: "",
        error: null,
        totalCostUsd: "1.25",
        costUsd: "0.75",
        costUsdCamel: "0.5",
      }),
    ).toEqual({
      summary: "Completed the task",
      result: "Updated three files",
      total_cost_usd: 1.25,
      cost_usd: 0.75,
      costUsd: 0.5,
    });
  });

  it("returns null when projected fields are empty", () => {
    expect(
      summarizeHeartbeatRunListResultJson({
        summary: "",
        result: null,
        message: undefined,
        error: "   ",
        totalCostUsd: "abc",
      }),
    ).toBeNull();
  });
});
