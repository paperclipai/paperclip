// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueBoardStateSummary } from "./IssueBoardStateSummary";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "COMA-1118",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue title",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1118,
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
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    ...overrides,
  };
}

describe("IssueBoardStateSummary", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders blocked row copy from boardState", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueBoardStateSummary
          issue={createIssue({
            boardState: {
              kind: "blocked",
              headline: "Blocked by COMA-1098",
              reasonCode: null,
              actorType: "issue",
              actorId: "blocker-1",
              primaryAction: null,
            },
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Blocked by COMA-1098");

    act(() => {
      root.unmount();
    });
  });

  it("renders waiting on QA from boardState", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueBoardStateSummary
          issue={createIssue({
            status: "in_review",
            boardState: {
              kind: "waiting",
              headline: "Waiting on QA",
              reasonCode: "review",
              actorType: "agent",
              actorId: "agent-qa",
              primaryAction: null,
            },
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Waiting on QA");

    act(() => {
      root.unmount();
    });
  });
});
