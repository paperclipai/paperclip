// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Issue, IssueExecutionState } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { ToastProvider } from "../context/ToastContext";
import { ToastViewport } from "./ToastViewport";
import {
  IssueExecutionStageApprovalBanner,
  isExecutionStagePendingForUser,
} from "./IssueExecutionStageApprovalBanner";

vi.mock("../api/issues", () => ({
  issuesApi: {
    update: vi.fn(() => Promise.resolve({})),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(cb: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = cb();
  });
  return result as T;
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Reviewed issue",
    description: null,
    status: "in_review",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: "user-1",
    responsibleUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "user-1",
    issueNumber: 1,
    identifier: "PAP-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    blockedBy: [],
    blocks: [],
    createdAt: new Date("2026-04-06T12:00:00.000Z"),
    updatedAt: new Date("2026-04-06T12:05:00.000Z"),
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  } as Issue;
}

function pendingReviewState(overrides: Partial<IssueExecutionState> = {}): IssueExecutionState {
  return {
    status: "pending",
    currentStageId: "stage-1",
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "user", agentId: null, userId: "user-1" },
    returnAssignee: { type: "agent", agentId: "agent-1", userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

function render(issue: Issue, currentUserId: string | null) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() =>
    root?.render(
      <ToastProvider>
        <QueryClientProvider client={client}>
          <IssueExecutionStageApprovalBanner issue={issue} currentUserId={currentUserId} />
          <ToastViewport />
        </QueryClientProvider>
      </ToastProvider>,
    ),
  );
  return container;
}

function setTextareaValue(element: HTMLTextAreaElement | null, value: string) {
  if (!element) throw new Error("Expected a textarea to exist");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function clickButton(testId: string) {
  const button = container?.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  act(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("isExecutionStagePendingForUser", () => {
  it("is false with no execution state", () => {
    expect(isExecutionStagePendingForUser({ id: "i1", executionState: null }, "user-1")).toBe(false);
  });

  it("is false when the stage is not pending (e.g. changes_requested)", () => {
    const state = pendingReviewState({ status: "changes_requested" });
    expect(isExecutionStagePendingForUser({ id: "i1", executionState: state }, "user-1")).toBe(false);
  });

  it("is false when the current participant is an agent, not a user", () => {
    const state = pendingReviewState({ currentParticipant: { type: "agent", agentId: "agent-1", userId: null } });
    expect(isExecutionStagePendingForUser({ id: "i1", executionState: state }, "user-1")).toBe(false);
  });

  it("is false when the current participant is a different user", () => {
    const state = pendingReviewState({ currentParticipant: { type: "user", agentId: null, userId: "user-2" } });
    expect(isExecutionStagePendingForUser({ id: "i1", executionState: state }, "user-1")).toBe(false);
  });

  it("is true when the pending stage's user participant matches", () => {
    const state = pendingReviewState();
    expect(isExecutionStagePendingForUser({ id: "i1", executionState: state }, "user-1")).toBe(true);
  });
});

describe("IssueExecutionStageApprovalBanner", () => {
  it("renders nothing when no stage is pending on the signed-in user", () => {
    const issue = createIssue({ executionState: null });
    const node = render(issue, "user-1");
    expect(node.querySelector('[data-testid="issue-execution-stage-approval-banner"]')).toBeNull();
  });

  it("renders nothing when the pending stage belongs to a different user", () => {
    const issue = createIssue({
      executionState: pendingReviewState({ currentParticipant: { type: "user", agentId: null, userId: "user-2" } }),
    });
    const node = render(issue, "user-1");
    expect(node.querySelector('[data-testid="issue-execution-stage-approval-banner"]')).toBeNull();
  });

  it("disables Approve and Request changes until a comment is entered, matching the backend's comment requirement", () => {
    const issue = createIssue({ executionState: pendingReviewState() });
    const node = render(issue, "user-1");
    expect(node.querySelector('[data-testid="issue-execution-stage-approval-banner"]')).not.toBeNull();

    const approve = node.querySelector<HTMLButtonElement>('[data-testid="issue-execution-stage-approve"]');
    const requestChanges = node.querySelector<HTMLButtonElement>(
      '[data-testid="issue-execution-stage-request-changes"]',
    );
    expect(approve?.disabled).toBe(true);
    expect(requestChanges?.disabled).toBe(true);
  });

  it("approves with a comment via PATCH { status: 'done', comment }", async () => {
    const issue = createIssue({ executionState: pendingReviewState() });
    const node = render(issue, "user-1");

    setTextareaValue(
      node.querySelector<HTMLTextAreaElement>('[data-testid="issue-execution-stage-approval-comment"]'),
      "Looks good.",
    );
    clickButton("issue-execution-stage-approve");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", { status: "done", comment: "Looks good." });
  });

  it("requests changes with a comment via PATCH { status: 'in_progress', comment }", async () => {
    const issue = createIssue({ executionState: pendingReviewState() });
    const node = render(issue, "user-1");

    setTextareaValue(
      node.querySelector<HTMLTextAreaElement>('[data-testid="issue-execution-stage-approval-comment"]'),
      "Please fix the typo.",
    );
    clickButton("issue-execution-stage-request-changes");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(issuesApi.update).toHaveBeenCalledWith("issue-1", {
      status: "in_progress",
      comment: "Please fix the typo.",
    });
  });
});
