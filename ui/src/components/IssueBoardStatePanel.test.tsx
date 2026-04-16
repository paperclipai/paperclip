// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ComponentProps } from "react";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueBoardStatePanel } from "./IssueBoardStatePanel";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    asChild,
    ...props
  }: ComponentProps<"button"> & { asChild?: boolean }) => {
    if (asChild) return children;
    return <button {...props}>{children}</button>;
  },
}));

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
    status: "blocked",
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

describe("IssueBoardStatePanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the root blocker headline and CTA for blocked issues", () => {
    const root = createRoot(container);
    const issue = createIssue({
      boardState: {
        kind: "blocked",
        headline: "Blocked by COMA-1098",
        reasonCode: null,
        actorType: "issue",
        actorId: "blocker-1",
        primaryAction: {
          type: "open_blocker",
          label: "Go to blocker",
          targetEntity: "issue",
          targetId: "blocker-1",
        },
      },
      primaryBlocker: {
        issueId: "blocker-1",
        identifier: "COMA-1098",
        title: "Primary blocker",
        blockedIssueCount: 4,
        pathLength: 3,
      },
      blockerPath: [
        {
          issueId: "issue-2",
          identifier: "COMA-1114",
          title: "Immediate blocker",
          status: "blocked",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
        {
          issueId: "issue-3",
          identifier: "COMA-1107",
          title: "Middle blocker",
          status: "blocked",
          priority: "high",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
        {
          issueId: "blocker-1",
          identifier: "COMA-1098",
          title: "Primary blocker",
          status: "todo",
          priority: "critical",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
    });

    act(() => {
      root.render(<IssueBoardStatePanel issue={issue} />);
    });

    expect(container.textContent).toContain("Blocked by COMA-1098");
    expect(container.textContent).toContain("Go to blocker");
    expect(container.textContent).toContain("COMA-1114");
    expect(container.textContent).toContain("COMA-1107");
    const actionLink = Array.from(container.querySelectorAll("a")).find((node) => node.textContent === "Go to blocker");
    expect(actionLink?.getAttribute("href")).toBe("/issues/COMA-1098");

    act(() => {
      root.unmount();
    });
  });

  it("renders a system inconsistency warning for invalid blocked state", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueBoardStatePanel
          issue={createIssue({
            boardState: {
              kind: "system_error",
              headline: "System error in issue state",
              reasonCode: "invalid_state",
              actorType: "system",
              actorId: "issue-1",
              primaryAction: {
                type: "open_issue",
                label: "Inspect issue state",
                targetEntity: "issue",
                targetId: "issue-1",
              },
            },
          })}
        />,
      );
    });

    expect(container.textContent).toContain("System error in issue state");
    expect(container.textContent).toContain("Inspect issue state");

    act(() => {
      root.unmount();
    });
  });

  it("renders redirect copy and opens the successor issue when recovery has moved work elsewhere", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueBoardStatePanel
          issue={createIssue({
            boardState: {
              kind: "redirected",
              headline: "Superseded by COMA-1122",
              reasonCode: "recovery",
              actorType: "issue",
              actorId: "issue-successor",
              primaryAction: {
                type: "open_issue",
                label: "Open successor",
                targetEntity: "issue",
                targetId: "issue-successor",
              },
            },
          })}
        />,
      );
    });

    expect(container.textContent).toContain("Superseded by COMA-1122");
    expect(container.textContent).toContain("Open successor");
    const actionLink = Array.from(container.querySelectorAll("a")).find((node) => node.textContent === "Open successor");
    expect(actionLink?.getAttribute("href")).toBe("/issues/issue-successor");

    act(() => {
      root.unmount();
    });
  });
});
