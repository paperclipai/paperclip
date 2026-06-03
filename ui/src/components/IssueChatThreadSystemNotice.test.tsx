// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueChatThread } from "./IssueChatThread";
import type { IssueChatComment } from "../lib/issue-chat-messages";
import type { Agent, SuccessfulRunHandoffState } from "@paperclipai/shared";

vi.mock("@assistant-ui/react", () => ({
  AssistantRuntimeProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useAui: () => ({ thread: () => ({ append: async () => undefined }) }),
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

vi.mock("./MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./MarkdownEditor", () => ({
  MarkdownEditor: () => <textarea aria-label="Issue chat editor" />,
}));

vi.mock("./InlineEntitySelector", () => ({ InlineEntitySelector: () => null }));
vi.mock("./Identity", () => ({ Identity: ({ name }: { name: string }) => <span>{name}</span> }));
vi.mock("./OutputFeedbackButtons", () => ({ OutputFeedbackButtons: () => null }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("./AgentIconPicker", () => ({ AgentIcon: () => null }));
vi.mock("./StatusBadge", () => ({ StatusBadge: ({ status }: { status: string }) => <span>{status}</span> }));
vi.mock("./IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({
    children,
    to,
  }: {
    children: ReactNode;
    to: string;
  }) => <a href={to}>{children}</a>,
}));
vi.mock("../hooks/usePaperclipIssueRuntime", () => ({
  usePaperclipIssueRuntime: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  window.scrollTo = vi.fn();
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
});

function renderThread(
  comments: IssueChatComment[],
  options: {
    agentMap?: Map<string, Agent>;
    issueStatus?: string;
    successfulRunHandoff?: SuccessfulRunHandoffState | null;
  } = {},
) {
  act(() => {
    root.render(
      <MemoryRouter>
        <IssueChatThread
          comments={comments}
          linkedRuns={[]}
          timelineEvents={[]}
          liveRuns={[]}
          onAdd={async () => {}}
          showComposer={false}
          enableLiveTranscriptPolling={false}
          agentMap={options.agentMap}
          issueStatus={options.issueStatus}
          successfulRunHandoff={options.successfulRunHandoff}
        />
      </MemoryRouter>,
    );
  });
}

const baseTimestamps = {
  createdAt: new Date("2026-05-04T16:32:00.000Z"),
  updatedAt: new Date("2026-05-04T16:32:00.000Z"),
};

describe("IssueChatThread system notice routing", () => {
  it("renders authorType=system comments as a SystemNotice rather than a user bubble", () => {
    const comment: IssueChatComment = {
      id: "comment-system",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: "Paperclip needs a disposition before this issue can continue.",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Missing issue disposition",
        detailsDefaultOpen: false,
      },
      metadata: {
        version: 1,
        sections: [
          {
            title: "Required action",
            rows: [
              { type: "issue_link", label: "Source issue", issueId: "i1", identifier: "PAP-3440", title: "Recovery" },
              { type: "key_value", label: "Status before", value: "in_progress" },
            ],
          },
        ],
      },
      ...baseTimestamps,
    };

    renderThread([comment]);

    const row = container.querySelector('[data-message-role="system"]');
    expect(row).not.toBeNull();
    const status = row?.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("Missing issue disposition");
    expect(container.textContent).toContain("Paperclip needs a disposition");
    // collapsed by default — metadata identifier should not be visible
    expect(container.textContent).not.toContain("PAP-3440");
    const toggle = row?.querySelector("button[aria-expanded]") as HTMLButtonElement | null;
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelectorAll('[data-message-role="user"]').length).toBe(0);
  });

  it("expands metadata when detailsDefaultOpen is true", () => {
    const comment: IssueChatComment = {
      id: "comment-system-open",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: "Recovery escalated.",
      presentation: {
        kind: "system_notice",
        tone: "danger",
        title: null,
        detailsDefaultOpen: true,
      },
      metadata: {
        version: 1,
        sections: [
          {
            rows: [
              { type: "agent_link", label: "Owner", agentId: "agent-cto", name: "CTO" },
            ],
          },
        ],
      },
      ...baseTimestamps,
    };

    renderThread([comment]);

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-label")).toBe("System alert");
    expect(container.textContent).toContain("CTO");
    const toggle = container.querySelector("button[aria-expanded]");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  });

  it("falls back to legacy user bubble + handoff callout for old text-only comments", () => {
    const comment: IssueChatComment = {
      id: "comment-legacy",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "user-1",
      body: "## Successful run missing issue disposition\n\nFix this.",
      presentation: null,
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    expect(container.querySelector('[role="status"]')).toBeNull();
    const userRow = container.querySelector('[data-message-role="user"]');
    expect(userRow).not.toBeNull();
    expect(container.textContent).toContain("Successful run missing issue disposition");
  });

  it("keeps regular user comments rendering as user bubbles", () => {
    const comment: IssueChatComment = {
      id: "comment-user",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user",
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Standard user message.",
      presentation: null,
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-message-role="user"]')).not.toBeNull();
    expect(container.textContent).toContain("Standard user message.");
  });

  it("keeps agent-authored comments rendering as assistant bubbles even with system_notice presentation absent", () => {
    const comment: IssueChatComment = {
      id: "comment-agent",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "agent",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Agent reply",
      presentation: null,
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-message-role="assistant"]')).not.toBeNull();
  });

  it("labels system notice source as the originating run agent name when runAgentId is available", () => {
    const codexAgent = {
      id: "agent-codex",
      name: "CodexCoder",
    } as unknown as Agent;
    const agentMap = new Map<string, Agent>([[codexAgent.id, codexAgent]]);
    const comment: IssueChatComment = {
      id: "comment-system-runagent",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      runId: "run-issue-chat-01",
      runAgentId: "agent-codex",
      body: "Paperclip needs a disposition before this issue can continue.",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Missing issue disposition",
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment], { agentMap });

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    const sourceLink = status?.querySelector('a[href^="/agents/"]') as HTMLAnchorElement | null;
    expect(sourceLink?.getAttribute("href")).toBe("/agents/agent-codex/runs/run-issue-chat-01");
    expect(sourceLink?.textContent).toBe("CodexCoder");
    expect(sourceLink?.textContent).not.toBe("You");
  });

  it("shows copy-link feedback on the link button only", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const comment: IssueChatComment = {
      id: "comment-copy-link",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      body: "System recovery completed.",
      presentation: {
        kind: "system_notice",
        tone: "success",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    const copyLink = container.querySelector('button[aria-label="Copy link to system notice"]') as HTMLButtonElement;
    const copyText = container.querySelector('button[aria-label="Copy system notice"]') as HTMLButtonElement;
    await act(async () => {
      copyLink.click();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("#comment-comment-copy-link"));
    expect(copyLink.querySelector(".lucide-check")).not.toBeNull();
    expect(copyText.querySelector(".lucide-check")).toBeNull();
  });

  it("labels system notice source as Paperclip when no run agent can be resolved", () => {
    const comment: IssueChatComment = {
      id: "comment-system-no-author",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      runId: null,
      runAgentId: null,
      body: "System recovery completed.",
      presentation: {
        kind: "system_notice",
        tone: "info",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toContain("Paperclip");
    expect(status?.textContent).not.toContain("You");
  });

  it("falls back to Paperclip in the system notice header when run agent is unknown to agentMap", () => {
    const comment: IssueChatComment = {
      id: "comment-system-unknown-agent",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      runId: "run-xyz",
      runAgentId: "agent-unknown",
      body: "Disposition required.",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    const status = container.querySelector('[role="status"]');
    const sourceLink = status?.querySelector('a[href^="/agents/"]') as HTMLAnchorElement | null;
    expect(sourceLink?.getAttribute("href")).toBe("/agents/agent-unknown/runs/run-xyz");
    expect(sourceLink?.textContent).toBe("Paperclip");
  });

  it("keeps agent-authored comments as assistant bubbles even when presentation requests system_notice", () => {
    const comment: IssueChatComment = {
      id: "comment-agent-system",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "agent",
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Reassigned to ClaudeFixer.",
      presentation: {
        kind: "system_notice",
        tone: "neutral",
        title: null,
        detailsDefaultOpen: false,
      },
      metadata: null,
      ...baseTimestamps,
    };

    renderThread([comment]);

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-message-role="assistant"]')).not.toBeNull();
  });

  it("folds stale successful-run disposition warnings into the activity log disclosure style", () => {
    const comment: IssueChatComment = {
      id: "comment-stale-disposition-warning",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "system",
      authorAgentId: null,
      authorUserId: null,
      runId: "run-stale",
      runAgentId: "agent-codex",
      body: "Paperclip needs a disposition before this issue can continue.",
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "Missing issue disposition",
        detailsDefaultOpen: false,
      },
      metadata: {
        version: 1,
        sourceRunId: "run-stale",
        sections: [
          {
            title: "Run evidence",
            rows: [
              { type: "run_link", label: "Completed run", runId: "run-stale", title: "succeeded" },
              { type: "key_value", label: "Normalized cause", value: "successful_run_missing_state" },
            ],
          },
        ],
      },
      ...baseTimestamps,
    };

    renderThread([comment], {
      issueStatus: "done",
      successfulRunHandoff: {
        state: "resolved",
        required: false,
        sourceRunId: "run-stale",
        correctiveRunId: "run-corrective",
        assigneeAgentId: "agent-codex",
        detectedProgressSummary: null,
        createdAt: new Date("2026-05-04T17:00:00.000Z"),
      },
    });

    const row = container.querySelector('[data-testid="stale-disposition-warning"]');
    expect(row).not.toBeNull();
    expect(row?.querySelector('span[aria-hidden="true"]')?.className).toContain("size-6");
    const toggle = row?.querySelector("button[aria-expanded]") as HTMLButtonElement;
    expect(toggle.className).toContain("w-full");
    expect(toggle.className).toContain("py-0.5");
    expect(row?.querySelector('[role="status"]')).toBeNull();
    expect(row?.querySelector(".lucide-triangle-alert")).toBeNull();
    expect(row?.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(row?.querySelector('[data-testid="stale-disposition-warning-time"]')?.parentElement?.className).toContain("ml-auto");
    expect(row?.textContent).toContain("Stale disposition warning");
    expect(row?.textContent).not.toContain("This disposition warning is stale because the issue now has a newer disposition.");
    expect(row?.textContent).not.toContain("Paperclip needs a disposition before this issue can continue.");

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const detailsId = toggle.getAttribute("aria-controls");
    expect(detailsId).toBeTruthy();
    const details = detailsId ? container.ownerDocument.getElementById(detailsId) : null;
    expect(details).not.toBeNull();
    expect(details?.textContent).toContain("run-stale");
    expect(details).toHaveProperty("hidden", true);
    act(() => {
      toggle.click();
    });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(details).toHaveProperty("hidden", false);
    expect(container.textContent).toContain("run-stale");
  });
});
