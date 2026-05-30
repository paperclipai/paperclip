import { describe, expect, it } from "vitest";
import { renderPaperclipGoalPrompt, renderTaskBindingGuard, resolveBoundIssueId } from "./server-utils.js";

describe("server prompt guards", () => {
  it("extracts the bound issue id from task or issue context", () => {
    expect(resolveBoundIssueId({ taskId: "task-123", issueId: "issue-456" })).toBe("task-123");
    expect(resolveBoundIssueId({ issueId: "issue-456" })).toBe("issue-456");
    expect(resolveBoundIssueId({})).toBeNull();
  });

  it("renders a bound-task guard with canonical issue routes", () => {
    const note = renderTaskBindingGuard({ taskId: "task-123" });

    expect(note).toContain("This heartbeat is bound to issue task-123");
    expect(note).toContain("Do not scan the inbox, backlog, or other issues");
    expect(note).toContain("GET /api/issues/{id}/heartbeat-context");
    expect(note).toContain("PATCH /api/issues/{id}");
    expect(note).toContain("POST /api/issues/{id}/release");
  });

  it("renders a binding-failure guard when wake context lacks a bound issue id", () => {
    const note = renderTaskBindingGuard({
      wakeReason: "managed_issue_created",
      wakeCommentId: "comment-123",
    });

    expect(note).toContain("does not include a bound issue id");
    expect(note).toContain("Do not compensate by scanning the inbox");
    expect(note).toContain("Report the binding failure and exit cleanly");
  });

  it("renders issue objective, evidence requirements, token budget, and closeout proof rules", () => {
    const note = renderPaperclipGoalPrompt({
      taskId: "issue-123",
      paperclipCodexGoal: {
        issueId: "issue-123",
        objective: "Make the assigned WebApp issue goal-aware.",
        evidenceRequirements: [
          "Show the prompt contains the issue objective.",
          "Run the targeted Codex adapter test.",
        ],
        tokenBudget: "6000 tokens",
        timeoutSec: 1800,
        issue: {
          id: "issue-123",
          identifier: "BLU-123",
          title: "Goal-aware Codex run",
        },
        goal: {
          title: "Paperclip execution reliability",
          description: "Keep implementation work tied to issue proof.",
        },
        project: {
          name: "Blueprint-WebApp",
        },
      },
    });

    expect(note).toContain("Goal: Make the assigned WebApp issue goal-aware.");
    expect(note).toContain("Issue: BLU-123 (issue-123)");
    expect(note).toContain("Project: Blueprint-WebApp");
    expect(note).toContain("Parent goal: Paperclip execution reliability");
    expect(note).toContain("Token budget: 6000 tokens");
    expect(note).toContain("Timeout: 1800 seconds");
    expect(note).toContain("Show the prompt contains the issue objective.");
    expect(note).toContain("Shared state evidence checklist");
    expect(note).toContain("Awaiting-human proof");
    expect(note).toContain("State claimed: exactly one of `done`, `blocked`, or `awaiting_human_decision`.");
    expect(note).toContain("Stage reached:");
    expect(note).toContain("Proof paths and command outputs:");
    expect(note).toContain("Next action / retry condition:");
    expect(note).toContain("Residual risk:");
    expect(note).toContain("update issue issue-123 to status done");
    expect(note).toContain("update issue issue-123 to status blocked");
    expect(note).toContain("Do not finish with only a chat final answer");
  });
});
