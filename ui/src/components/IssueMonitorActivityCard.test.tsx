// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueMonitorActivityCard } from "./IssueMonitorActivityCard";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Watch deploy",
    description: null,
    status: "in_progress",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
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
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment health",
        scheduledBy: "board",
      },
    },
    executionState: {
      status: "idle",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: null,
      currentParticipant: null,
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      monitor: {
        status: "scheduled",
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        lastTriggeredAt: null,
        attemptCount: 0,
        notes: "Check deployment health",
        scheduledBy: "board",
        clearedAt: null,
        clearReason: null,
      },
    },
    monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
    monitorLastTriggeredAt: null,
    monitorAttemptCount: 0,
    monitorNotes: "Check deployment health",
    monitorScheduledBy: "board",
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-11T10:00:00.000Z"),
    updatedAt: new Date("2026-04-11T10:00:00.000Z"),
    ...overrides,
  };
}

describe("IssueMonitorActivityCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T12:00:00.000Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders the scheduled monitor details and check-now action", () => {
    const onCheckNow = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(<IssueMonitorActivityCard issue={createIssue()} onCheckNow={onCheckNow} />);
    });

    expect(container.textContent).toContain("Monitor scheduled");
    expect(container.textContent).toContain("Next check");
    expect(container.textContent).toContain("in 30m");
    expect(container.textContent).toContain("Check deployment health");

    const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
      candidate.textContent?.includes("Check now"),
    );
    expect(button).toBeTruthy();

    act(() => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCheckNow).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });

  it("does not render external references from monitor metadata", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueMonitorActivityCard
          issue={createIssue({
            executionPolicy: {
              mode: "normal",
              commentRequired: true,
              stages: [],
              monitor: {
                nextCheckAt: "2026-04-11T12:30:00.000Z",
                notes: "Check deployment health",
                scheduledBy: "board",
                serviceName: "Deploy provider",
                externalRef: "https://provider.example/deploy/123?token=secret",
              },
            },
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Deploy provider");
    expect(container.textContent).not.toContain("provider.example");
    expect(container.textContent).not.toContain("token=secret");

    act(() => root.unmount());
  });

  it("renders nothing when the issue has no scheduled monitor", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueMonitorActivityCard
          issue={createIssue({
            executionPolicy: {
              mode: "normal",
              commentRequired: true,
              stages: [],
            },
            executionState: {
              status: "idle",
              currentStageId: null,
              currentStageIndex: null,
              currentStageType: null,
              currentParticipant: null,
              returnAssignee: null,
              reviewRequest: null,
              completedStageIds: [],
              lastDecisionId: null,
              lastDecisionOutcome: null,
              monitor: null,
            },
            monitorNextCheckAt: null,
            monitorNotes: null,
          })}
        />,
      );
    });

    expect(container.textContent).toBe("");

    act(() => root.unmount());
  });
});
