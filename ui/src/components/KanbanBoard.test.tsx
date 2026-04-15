// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KanbanBoard } from "./KanbanBoard";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: React.ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
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
    title: "Kanban card",
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
    createdAt: new Date("2026-04-07T00:00:00.000Z"),
    updatedAt: new Date("2026-04-07T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
  };
}

describe("KanbanBoard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("shows each ticket's last updated time in the header", () => {
    const root = createRoot(container);
    const issue = createIssue({
      updatedAt: new Date("2026-04-07T10:00:00.000Z"),
    });

    act(() => {
      root.render(
        <KanbanBoard
          issues={[issue]}
          onUpdateIssue={() => undefined}
        />,
      );
    });

    const card = container.querySelector('[data-kanban-card-id="issue-1"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Updated 2h ago");

    act(() => {
      root.unmount();
    });
  });

  it("applies epic color classes to matching cards", () => {
    const root = createRoot(container);
    const issue = createIssue();

    act(() => {
      root.render(
        <KanbanBoard
          issues={[issue]}
          onUpdateIssue={() => undefined}
          epicStylesByIssueId={
            new Map([
              [
                issue.id,
                {
                  cardClassName: "border-cyan-300/70 bg-cyan-50/40 dark:border-cyan-800/70",
                },
              ],
            ])
          }
        />,
      );
    });

    const card = container.querySelector('[data-kanban-card-id="issue-1"]');
    expect(card).not.toBeNull();
    expect(card?.className).toContain("border-cyan-300/70");
    expect(card?.className).toContain("bg-cyan-50/40");

    act(() => {
      root.unmount();
    });
  });

  it("shows 15 cards per column by default and expands with show more", () => {
    const root = createRoot(container);
    const issues = Array.from({ length: 17 }, (_, index) =>
      createIssue({
        id: `issue-${index + 1}`,
        identifier: `PAP-${index + 1}`,
        title: `Kanban card ${index + 1}`,
        status: "todo",
      }),
    );

    act(() => {
      root.render(
        <KanbanBoard
          issues={issues}
          onUpdateIssue={() => undefined}
        />,
      );
    });

    expect(container.querySelectorAll("[data-kanban-card-id]").length).toBe(15);
    const showMoreButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Show 2 more (2 hidden)"),
    );
    expect(showMoreButton).toBeDefined();

    act(() => {
      showMoreButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.querySelectorAll("[data-kanban-card-id]").length).toBe(17);
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Show 2 more (2 hidden)"),
      ),
    ).toBe(false);

    act(() => {
      root.unmount();
    });
  });
});
