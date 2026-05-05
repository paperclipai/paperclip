// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Agent, Approval } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentThread } from "./CommentThread";

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children, className }: { children: ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: ({ value, onChange, placeholder }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  }) => (
    <textarea
      aria-label="Comment editor"
      value={value}
      placeholder={placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("./InlineEntitySelector", () => ({
  InlineEntitySelector: () => null,
}));

vi.mock("./ApprovalCard", () => ({
  ApprovalCard: ({
    approval,
    onApprove,
    onReject,
  }: {
    approval: Approval;
    onApprove?: () => void;
    onReject?: () => void;
  }) => (
    <div>
      <div>{approval.type}</div>
      <div>{String(approval.payload.title ?? "")}</div>
      {onApprove ? <button type="button" onClick={onApprove}>Approve</button> : null}
      {onReject ? <button type="button" onClick={onReject}>Reject</button> : null}
    </div>
  ),
}));

vi.mock("@/plugins/slots", () => ({
  PluginSlotOutlet: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CommentThread", () => {
  let container: HTMLDivElement;
  let writeTextMock: ReturnType<typeof vi.fn>;
  let execCommandMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-11T12:00:00.000Z"));
    writeTextMock = vi.fn(async () => {});
    execCommandMock = vi.fn(() => true);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });
    Object.defineProperty(window, "isSecureContext", {
      value: true,
      configurable: true,
    });
    document.execCommand = execCommandMock;
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders historical runs as timeline rows using the finished time", () => {
    const root = createRoot(container);
    const agent: Agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "CodexCoder",
      urlKey: "codexcoder",
      role: "engineer",
      title: null,
      icon: "code",
      status: "active",
      reportsTo: null,
      capabilities: null,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date("2026-03-11T00:00:00.000Z"),
      updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    };

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[]}
            linkedRuns={[{
              runId: "run-12345678abcd",
              status: "succeeded",
              agentId: "agent-1",
              createdAt: "2026-03-11T07:00:00.000Z",
              startedAt: "2026-03-11T08:00:00.000Z",
              finishedAt: "2026-03-11T10:00:00.000Z",
            }]}
            agentMap={new Map([["agent-1", agent]])}
            onAdd={async () => {}}
          />
        </MemoryRouter>,
      );
    });

    const runRow = container.querySelector("#run-run-12345678abcd") as HTMLDivElement | null;
    expect(runRow).not.toBeNull();
    expect(runRow?.className).toContain("py-1.5");
    expect(runRow?.className).toContain("items-center");
    expect(runRow?.className).not.toContain("border");
    expect(container.textContent).toContain("CodexCoder");
    expect(container.textContent).toContain("succeeded");
    expect(container.textContent).toContain("2h ago");
    expect(container.textContent).not.toContain("4h ago");
    const runLink = container.querySelector('a[href="/agents/agent-1/runs/run-12345678abcd"]') as HTMLAnchorElement | null;
    expect(runLink?.textContent).toContain("run-1234");
    expect(runLink?.className).toContain("rounded-md");
    expect(runLink?.className).toContain("px-2");

    act(() => {
      root.unmount();
    });
  });

  it("replaces the composer with a warning when comments are disabled", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[]}
            composerDisabledReason="Workspace is closed."
            onAdd={async () => {}}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Workspace is closed.");
    expect(container.querySelector('textarea[aria-label="Comment editor"]')).toBeNull();
    expect(container.textContent).not.toContain("Comment");

    act(() => {
      root.unmount();
    });
  });

  it("shows follow-up badges on explicit follow-up comments and timeline rows", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[{
              id: "comment-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "local-board",
              body: "Please continue validation.",
              followUpRequested: true,
              createdAt: new Date("2026-03-11T10:00:00.000Z"),
              updatedAt: new Date("2026-03-11T10:00:00.000Z"),
            }]}
            timelineEvents={[{
              id: "event-1",
              actorType: "agent",
              actorId: "agent-1",
              createdAt: new Date("2026-03-11T10:00:00.000Z"),
              commentId: "comment-1",
              followUpRequested: true,
            }]}
            onAdd={async () => {}}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).toContain("Follow-up");
    expect(container.textContent).toContain("requested follow-up");

    act(() => {
      root.unmount();
    });
  });

  it("hides the reopen control and infers reopen for closed agent-assigned issues", async () => {
    const root = createRoot(container);
    const onAdd = vi.fn(async () => {});

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[]}
            issueStatus="done"
            currentAssigneeValue="agent:agent-1"
            onAdd={onAdd}
          />
        </MemoryRouter>,
      );
    });

    expect(container.textContent).not.toContain("Re-open");

    const editor = container.querySelector('textarea[aria-label="Comment editor"]') as HTMLTextAreaElement | null;
    const submitButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.textContent === "Comment",
    ) as HTMLButtonElement | undefined;
    expect(editor).not.toBeNull();
    expect(submitButton).toBeDefined();

    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(editor, "Please pick this back up");
      editor?.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      submitButton?.click();
    });

    expect(onAdd).toHaveBeenCalledWith("Please pick this back up", true, undefined);

    act(() => {
      root.unmount();
    });
  });

  it("renders linked approvals inline in the timeline", () => {
    const root = createRoot(container);
    const agent: Agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "CodexCoder",
      urlKey: "codexcoder",
      role: "engineer",
      title: null,
      icon: "code",
      status: "active",
      reportsTo: null,
      capabilities: null,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      pauseReason: null,
      pausedAt: null,
      permissions: { canCreateAgents: false },
      lastHeartbeatAt: null,
      metadata: null,
      createdAt: new Date("2026-03-11T00:00:00.000Z"),
      updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    };
    const approval: Approval = {
      id: "approval-1",
      companyId: "company-1",
      type: "request_board_approval",
      requestedByAgentId: "agent-1",
      requestedByUserId: null,
      status: "pending",
      payload: {
        title: "Approve hosting spend",
        text: "Estimated monthly cost is $42.",
      },
      decisionNote: null,
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-03-11T09:00:00.000Z"),
      updatedAt: new Date("2026-03-11T09:00:00.000Z"),
    };

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[]}
            linkedApprovals={[approval]}
            agentMap={new Map([["agent-1", agent]])}
            onAdd={async () => {}}
            onApproveApproval={async () => {}}
            onRejectApproval={async () => {}}
          />
        </MemoryRouter>,
      );
    });

    const approvalRow = container.querySelector("#approval-approval-1") as HTMLDivElement | null;
    expect(approvalRow).not.toBeNull();
    expect(container.textContent).toContain("request_board_approval");
    expect(container.textContent).toContain("Approve hosting spend");
    expect(container.textContent).toContain("Approve");
    expect(container.textContent).toContain("Reject");

    act(() => {
      root.unmount();
    });
  });

  it("uses a larger copy control with feedback and a clipboard fallback", async () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <MemoryRouter>
          <CommentThread
            comments={[{
              id: "comment-1",
              companyId: "company-1",
              issueId: "issue-1",
              authorAgentId: null,
              authorUserId: "user-1",
              body: "Hello from the comment body",
              createdAt: new Date("2026-03-11T11:00:00.000Z"),
              updatedAt: new Date("2026-03-11T11:00:00.000Z"),
            }]}
            onAdd={async () => {}}
          />
        </MemoryRouter>,
      );
    });

    const copyButton = Array.from(container.querySelectorAll("button")).find(
      (element) => element.getAttribute("aria-label") === "Copy comment as markdown",
    ) as HTMLButtonElement | undefined;

    expect(copyButton).toBeDefined();
    expect(copyButton?.className).toContain("min-h-8");
    expect(copyButton?.textContent).toContain("Copy");

    Object.defineProperty(window, "isSecureContext", {
      value: false,
      configurable: true,
    });

    await act(async () => {
      copyButton?.click();
    });

    expect(writeTextMock).not.toHaveBeenCalled();
    expect(execCommandMock).toHaveBeenCalledWith("copy");
    expect(copyButton?.textContent).toContain("Copied");

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(copyButton?.textContent).toContain("Copy");

    act(() => {
      root.unmount();
    });
  });
});
