// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue, IssueExecutionState } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IssueExecutionStageDecisionCard,
  pendingExecutionStageForUser,
} from "./IssueExecutionStageDecisionCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const BOARD_USER_ID = "board-user-1";

function pendingApprovalState(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-2",
    currentStageIndex: 1,
    currentStageType: "approval",
    currentParticipant: { type: "user", userId: BOARD_USER_ID, agentId: null },
    returnAssignee: { type: "agent", userId: null, agentId: "agent-1" },
    reviewRequest: null,
    completedStageIds: ["stage-1"],
    lastDecisionId: null,
    lastDecisionOutcome: "approved",
    monitor: null,
    ...overrides,
  };
}

// NEO-500 repro shape: user-participant approval stage where the issue is also
// assigned to that user (assignee == currentParticipant), i.e. the state the
// server's orphan-repair considers "affordance present".
function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Wedged approval",
    description: null,
    status: "in_review",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: BOARD_USER_ID,
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: {
      mode: "normal",
      commentRequired: true,
      stages: [],
    },
    executionState: pendingApprovalState(),
    monitorNextCheckAt: null,
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: null,
    monitorScheduledBy: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-07-17T10:00:00.000Z"),
    updatedAt: new Date("2026-07-17T10:00:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

function typeComment(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea");
  expect(textarea).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea!, text);
    textarea!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findButton(container: HTMLElement, label: string) {
  return Array.from(container.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes(label),
  );
}

describe("pendingExecutionStageForUser", () => {
  it("matches a user-participant approval stage for that user", () => {
    expect(pendingExecutionStageForUser(createIssue(), BOARD_USER_ID)).toEqual({
      stageType: "approval",
      instructions: null,
    });
  });

  it("matches a review stage and surfaces review instructions", () => {
    const issue = createIssue({
      executionState: pendingApprovalState({
        currentStageType: "review",
        reviewRequest: { instructions: "Check the migration renumbering" },
      }),
    });
    expect(pendingExecutionStageForUser(issue, BOARD_USER_ID)).toEqual({
      stageType: "review",
      instructions: "Check the migration renumbering",
    });
  });

  it("returns null for a different user, an agent participant, or no pending stage", () => {
    expect(pendingExecutionStageForUser(createIssue(), "someone-else")).toBeNull();
    expect(pendingExecutionStageForUser(createIssue(), null)).toBeNull();
    expect(
      pendingExecutionStageForUser(
        createIssue({
          executionState: pendingApprovalState({
            currentParticipant: { type: "agent", userId: null, agentId: "agent-2" },
          }),
        }),
        BOARD_USER_ID,
      ),
    ).toBeNull();
    expect(
      pendingExecutionStageForUser(createIssue({ executionState: null }), BOARD_USER_ID),
    ).toBeNull();
    expect(
      pendingExecutionStageForUser(
        createIssue({ executionState: pendingApprovalState({ status: "changes_requested" }) }),
        BOARD_USER_ID,
      ),
    ).toBeNull();
    expect(
      pendingExecutionStageForUser(createIssue({ status: "done" }), BOARD_USER_ID),
    ).toBeNull();
  });
});

describe("IssueExecutionStageDecisionCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders approve/request-changes for the participant board user (NEO-500 repro)", () => {
    const onDecide = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueExecutionStageDecisionCard
          issue={createIssue()}
          currentUserId={BOARD_USER_ID}
          onDecide={onDecide}
        />,
      );
    });

    expect(container.textContent).toContain("Approval requested");
    const approve = findButton(container, "Approve");
    const requestChanges = findButton(container, "Request changes");
    expect(approve).toBeTruthy();
    expect(requestChanges).toBeTruthy();

    // Decision buttons stay disabled until a comment is provided (server
    // rejects stage decisions without a comment).
    expect(approve!.disabled).toBe(true);
    expect(requestChanges!.disabled).toBe(true);

    typeComment(container, "LGTM — merged as 38e1758b67");
    expect(approve!.disabled).toBe(false);

    act(() => {
      approve!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDecide).toHaveBeenCalledWith("approve", "LGTM — merged as 38e1758b67");

    act(() => root.unmount());
  });

  it("sends request_changes with the comment", () => {
    const onDecide = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueExecutionStageDecisionCard
          issue={createIssue({
            executionState: pendingApprovalState({ currentStageType: "review" }),
          })}
          currentUserId={BOARD_USER_ID}
          onDecide={onDecide}
        />,
      );
    });

    expect(container.textContent).toContain("Review requested");
    typeComment(container, "Please rebase first");

    const requestChanges = findButton(container, "Request changes");
    act(() => {
      requestChanges!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onDecide).toHaveBeenCalledWith("request_changes", "Please rebase first");

    act(() => root.unmount());
  });

  it("renders nothing for a non-participant viewer", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueExecutionStageDecisionCard
          issue={createIssue()}
          currentUserId="someone-else"
          onDecide={vi.fn()}
        />,
      );
    });

    expect(container.querySelector("[data-testid=execution-stage-decision-card]")).toBeNull();

    act(() => root.unmount());
  });

  it("disables actions while a decision is pending", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueExecutionStageDecisionCard
          issue={createIssue()}
          currentUserId={BOARD_USER_ID}
          onDecide={vi.fn()}
          isPending
          pendingDecision="approve"
        />,
      );
    });

    expect(container.textContent).toContain("Approving...");
    const approve = findButton(container, "Approving...");
    expect(approve!.disabled).toBe(true);

    act(() => root.unmount());
  });
});
