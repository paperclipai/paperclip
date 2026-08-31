// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IssueAssigneeAttention } from "@paperclipai/shared";
import { IssueAssigneeAttentionNotice } from "./IssueAssigneeAttentionNotice";

vi.mock("@/lib/router", () => ({
  Link: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const errorAttention: IssueAssigneeAttention = {
  state: "agent_error",
  agentId: "agent-err",
  agentName: "CodexCoder",
  errorReasonExcerpt: "Adapter crashed on startup",
};

const pausedAttention: IssueAssigneeAttention = {
  state: "agent_paused",
  agentId: "agent-paused",
  agentName: "CodexCoderAcpx",
  pauseReasonExcerpt: "manual",
};

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

describe("IssueAssigneeAttentionNotice", () => {
  it("renders nothing without attention", () => {
    act(() => {
      root.render(<IssueAssigneeAttentionNotice attention={null} />);
    });
    expect(container.querySelector('[data-testid="issue-assignee-error-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="issue-assignee-paused-notice"]')).toBeNull();
  });

  it("names the errored agent, links to it, shows the safe reason, and explains recovery", () => {
    act(() => {
      root.render(<IssueAssigneeAttentionNotice attention={errorAttention} />);
    });
    const notice = container.querySelector('[data-testid="issue-assignee-error-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Execution blocked");
    expect(notice?.textContent).toContain("CodexCoder");
    expect(notice?.textContent).toContain("error status");

    const link = container.querySelector('[data-testid="issue-assignee-attention-agent-link"]');
    expect(link?.getAttribute("to")).toBe("/agents/agent-err");

    const reason = container.querySelector('[data-testid="issue-assignee-error-reason"]');
    expect(reason?.textContent).toBe("Adapter crashed on startup");

    expect(notice?.textContent).toContain("Clear error");
    expect(notice?.textContent).toContain("reassign");
    expect(notice?.textContent).toContain("The issue status itself is unchanged.");
  });

  it("omits the reason line when no safe excerpt exists", () => {
    act(() => {
      root.render(
        <IssueAssigneeAttentionNotice
          attention={{ ...errorAttention, agentName: null, errorReasonExcerpt: null }}
        />,
      );
    });
    const notice = container.querySelector('[data-testid="issue-assignee-error-notice"]');
    expect(notice?.textContent).toContain("The assigned agent");
    expect(container.querySelector('[data-testid="issue-assignee-error-reason"]')).toBeNull();
  });

  it("renders paused attention as a warning with resume-or-reassign guidance, not a fault", () => {
    act(() => {
      root.render(<IssueAssigneeAttentionNotice attention={pausedAttention} />);
    });
    expect(container.querySelector('[data-testid="issue-assignee-error-notice"]')).toBeNull();
    const notice = container.querySelector('[data-testid="issue-assignee-paused-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain("Execution paused");
    expect(notice?.textContent).toContain("CodexCoderAcpx");
    expect(notice?.textContent).toContain("deliberate");
    expect(notice?.textContent).toContain("Resume");
    expect(notice?.textContent).toContain("reassign");
    expect(notice?.textContent).not.toContain("error");
    expect(notice?.className).toContain("amber");
    expect(notice?.className).not.toContain("destructive");

    const link = container.querySelector('[data-testid="issue-assignee-attention-agent-link"]');
    expect(link?.getAttribute("to")).toBe("/agents/agent-paused");

    const reason = container.querySelector('[data-testid="issue-assignee-paused-reason"]');
    expect(reason?.textContent).toBe("Pause reason: manual");
  });

  it("uses destructive severity only for the error state", () => {
    act(() => {
      root.render(<IssueAssigneeAttentionNotice attention={errorAttention} />);
    });
    const notice = container.querySelector('[data-testid="issue-assignee-error-notice"]');
    expect(notice?.className).toContain("destructive");
    expect(notice?.className).not.toContain("amber");
  });

  it("omits the paused reason line when no safe excerpt exists", () => {
    act(() => {
      root.render(
        <IssueAssigneeAttentionNotice
          attention={{ ...pausedAttention, agentName: null, pauseReasonExcerpt: null }}
        />,
      );
    });
    const notice = container.querySelector('[data-testid="issue-assignee-paused-notice"]');
    expect(notice?.textContent).toContain("The assigned agent");
    expect(container.querySelector('[data-testid="issue-assignee-paused-reason"]')).toBeNull();
  });
});
