// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { IssueAssignedBacklogNotice } from "./IssueAssignedBacklogNotice";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseAgent = {
  id: "agent-1",
  companyId: "co-1",
  name: "ClaudeCoder",
  role: "engineer",
  status: "active",
} as unknown as Agent;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

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

describe("IssueAssignedBacklogNotice", () => {
  it("renders nothing when status is not backlog", () => {
    act(() => {
      root.render(
        <IssueAssignedBacklogNotice
          issueStatus="todo"
          assigneeAgent={baseAgent}
          assigneeUserId={null}
        />,
      );
    });
    expect(container.querySelector('[data-testid="issue-assigned-backlog-notice"]')).toBeNull();
  });

  it("renders nothing when there is no assignee", () => {
    act(() => {
      root.render(
        <IssueAssignedBacklogNotice
          issueStatus="backlog"
          assigneeAgent={null}
          assigneeUserId={null}
        />,
      );
    });
    expect(container.querySelector('[data-testid="issue-assigned-backlog-notice"]')).toBeNull();
  });

  it("warns when an agent is assigned and the issue is parked in backlog", () => {
    act(() => {
      root.render(
        <IssueAssignedBacklogNotice
          issueStatus="backlog"
          assigneeAgent={baseAgent}
          assigneeUserId={null}
        />,
      );
    });
    const notice = container.querySelector('[data-testid="issue-assigned-backlog-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Parked");
    expect(notice?.textContent).toContain("ClaudeCoder");
  });

  it("calls onResume when the resume button is clicked", () => {
    const onResume = vi.fn();
    act(() => {
      root.render(
        <IssueAssignedBacklogNotice
          issueStatus="backlog"
          assigneeAgent={baseAgent}
          assigneeUserId={null}
          onResume={onResume}
        />,
      );
    });
    const button = container.querySelector('[data-testid="issue-assigned-backlog-resume"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    act(() => {
      button?.click();
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("disables the resume button while resuming", () => {
    act(() => {
      root.render(
        <IssueAssignedBacklogNotice
          issueStatus="backlog"
          assigneeAgent={baseAgent}
          assigneeUserId={null}
          onResume={() => undefined}
          resuming
        />,
      );
    });
    const button = container.querySelector('[data-testid="issue-assigned-backlog-resume"]') as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Resuming");
  });
});
