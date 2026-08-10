import { describe, expect, it } from "vitest";
import type {
  IssueRecoveryAction,
  IssueScheduledRetry,
  SuccessfulRunHandoffState,
} from "@paperclipai/shared";
import { resolveTaskNextAction, type TaskNextActionInput } from "./task-next-action";

// Minimal casts — the resolver only reads the fields asserted below, so the
// full shared shapes are unnecessary for a priority-order test.
const RECOVERY = {} as IssueRecoveryAction;
const RETRY_SCHEDULED = { status: "scheduled_retry" } as IssueScheduledRetry;
const HANDOFF_REQUIRED = { required: true, hasLiveContinuation: false } as SuccessfulRunHandoffState;

// Every rung's trigger present at once. Peeling one field at a time proves the
// ladder resolves top-down (FIRST match wins).
const ALL: TaskNextActionInput = {
  issueId: "issue-1",
  issueStatus: "blocked",
  recoveryAction: RECOVERY,
  blockedBy: [{ status: "todo" }],
  pendingApproval: { id: "appr-1" },
  interactions: [{ id: "int-1", status: "pending" }],
  scheduledRetry: RETRY_SCHEDULED,
  successfulRunHandoff: HANDOFF_REQUIRED,
  liveIssueIds: new Set(),
  hasLiveRun: true,
  agentName: "Ada",
};

describe("resolveTaskNextAction priority ladder", () => {
  it("1 — recovery wins over everything", () => {
    const action = resolveTaskNextAction(ALL);
    expect(action.kind).toBe("recovery");
    expect(action.tone).toBe("blocking");
    expect(action.cta).toEqual({ type: "expand", shelf: "recovery", label: "Review" });
  });

  it("2 — blocked wins once recovery is gone", () => {
    const action = resolveTaskNextAction({ ...ALL, recoveryAction: null });
    expect(action.kind).toBe("blocked");
    expect(action.tone).toBe("blocking");
    expect(action.cta).toEqual({ type: "expand", shelf: "blocked", label: "View blockers" });
    expect(action.title).toContain("Blocked by 1 task");
  });

  it("3 — approval wins once recovery + blocked are gone", () => {
    const action = resolveTaskNextAction({
      ...ALL,
      recoveryAction: null,
      blockedBy: [],
      issueStatus: "in_progress",
    });
    expect(action.kind).toBe("approval");
    expect(action.tone).toBe("review");
    expect(action.cta).toEqual({ type: "href", href: "/approvals/appr-1", label: "Review" });
  });

  it("4 — interaction wins once approval is gone", () => {
    const action = resolveTaskNextAction({
      ...ALL,
      recoveryAction: null,
      blockedBy: [],
      issueStatus: "in_progress",
      pendingApproval: null,
    });
    expect(action.kind).toBe("interaction");
    expect(action.tone).toBe("review");
    expect(action.cta).toEqual({ type: "scroll", targetId: "interaction:int-1", label: "Respond" });
  });

  it("5 — retry wins once interaction is gone", () => {
    const action = resolveTaskNextAction({
      ...ALL,
      recoveryAction: null,
      blockedBy: [],
      issueStatus: "in_progress",
      pendingApproval: null,
      interactions: [],
    });
    expect(action.kind).toBe("retry");
    expect(action.tone).toBe("blocking");
    expect(action.cta).toEqual({ type: "expand", shelf: "retry", label: "View retry" });
  });

  it("6 — handoff wins once retry is gone (and nothing is live)", () => {
    const action = resolveTaskNextAction({
      ...ALL,
      recoveryAction: null,
      blockedBy: [],
      issueStatus: "in_review",
      pendingApproval: null,
      interactions: [],
      scheduledRetry: null,
    });
    expect(action.kind).toBe("handoff");
    expect(action.tone).toBe("blocking");
    expect(action.cta).toEqual({ type: "expand", shelf: "handoff", label: "Choose next step" });
  });

  it("7 — review wins once handoff is gone", () => {
    const action = resolveTaskNextAction({
      ...ALL,
      recoveryAction: null,
      blockedBy: [],
      issueStatus: "in_review",
      pendingApproval: null,
      interactions: [],
      scheduledRetry: null,
      successfulRunHandoff: null,
    });
    expect(action.kind).toBe("review");
    expect(action.tone).toBe("review");
    expect(action.cta).toEqual({ type: "scroll", targetId: null, label: "Jump to latest" });
  });

  it("8 — working when only a live run remains", () => {
    const action = resolveTaskNextAction({
      issueId: "issue-1",
      issueStatus: "in_progress",
      hasLiveRun: true,
      agentName: "Ada",
    });
    expect(action.kind).toBe("working");
    expect(action.tone).toBe("positive");
    expect(action.title).toBe("On track — Ada is working");
    expect(action.cta).toBeUndefined();
  });

  it("9 — clear when nothing needs the viewer", () => {
    const action = resolveTaskNextAction({ issueId: "issue-1", issueStatus: "in_progress" });
    expect(action.kind).toBe("clear");
    expect(action.tone).toBe("positive");
    expect(action.cta).toBeUndefined();
  });
});
