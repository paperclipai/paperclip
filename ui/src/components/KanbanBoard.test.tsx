// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanBoard } from "./KanbanBoard";

vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: React.ComponentProps<"a"> & { to: string; disableIssueQuicklook?: boolean }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Board issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    dueDate: null,
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    lastActivityAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

describe("KanbanBoard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("highlights board cards assigned to the current user", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[
            createIssue({ id: "issue-mine", identifier: "PAP-6", title: "Mine", assigneeUserId: "board-user" }),
            createIssue({ id: "issue-other", identifier: "PAP-7", title: "Other", assigneeUserId: "other-user" }),
          ]}
          agents={[]}
          liveIssueIds={new Set()}
          currentUserId="board-user"
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const highlightedCards = Array.from(container.querySelectorAll('[data-assigned-to-current-user="true"]'));
    expect(highlightedCards).toHaveLength(1);
    expect(highlightedCards[0]?.textContent).toContain("Mine");
    expect(highlightedCards[0]?.className).toContain("border-l-4");
    expect(highlightedCards[0]?.className).toContain("bg-cyan-500");
    expect(container.querySelector('[aria-label="Assigned to You"]')).not.toBeNull();
  });

  it("highlights board cards assigned to visible company agents", () => {
    act(() => {
      root.render(
        <KanbanBoard
          issues={[
            createIssue({ id: "issue-agent", identifier: "PAP-8", title: "Agent work", assigneeAgentId: "agent-steward" }),
            createIssue({ id: "issue-other", identifier: "PAP-9", title: "Other work", assigneeAgentId: "agent-other" }),
          ]}
          agents={[{ id: "agent-steward", name: "Paperclip Steward" }]}
          liveIssueIds={new Set()}
          currentUserId="board-user"
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const highlightedCards = Array.from(container.querySelectorAll('[data-assigned-to-current-user="true"]'));
    expect(highlightedCards).toHaveLength(1);
    expect(highlightedCards[0]?.textContent).toContain("Agent work");
    expect(highlightedCards[0]?.className).toContain("border-l-4");
    expect(container.querySelector('[aria-label="Assigned to Paperclip Steward"]')).not.toBeNull();
  });
});
