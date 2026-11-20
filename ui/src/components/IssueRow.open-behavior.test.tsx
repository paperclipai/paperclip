// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueRow } from "./IssueRow";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    to,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch,
    ...props
  }: React.ComponentProps<"a"> & { to?: string; disableIssueQuicklook?: boolean; issuePrefetch?: Issue | null }) => (
    <a
      href={to}
      className={className}
      data-disable-issue-quicklook={_disableIssueQuicklook ? "true" : undefined}
      data-issue-prefetch-id={issuePrefetch?.id}
      {...props}
    >
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }

  flushSync(callback);
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Inbox item",
    description: null,
    status: "todo",
    priority: "medium",
    reviewPolicy: null,
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
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
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

describe("IssueRow onOpenIssue", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function renderRow(onOpenIssue: () => void) {
    const root = createRoot(container);
    act(() => {
      root.render(<IssueRow issue={createIssue()} onOpenIssue={onOpenIssue} />);
    });
    const link = container.querySelector("a");
    if (!link) throw new Error("Expected the row link");
    return { root, link };
  }

  it("opens the task on a plain click instead of following the link", () => {
    const onOpenIssue = vi.fn();
    const { root, link } = renderRow(onOpenIssue);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });

    act(() => {
      link.dispatchEvent(event);
    });

    expect(onOpenIssue).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    act(() => {
      root.unmount();
    });
  });

  it.each([
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
  ])("follows the link on a %s click", (_name, modifiers) => {
    const onOpenIssue = vi.fn();
    const { root, link } = renderRow(onOpenIssue);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...modifiers });

    act(() => {
      link.dispatchEvent(event);
    });

    expect(onOpenIssue).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    act(() => {
      root.unmount();
    });
  });
});
