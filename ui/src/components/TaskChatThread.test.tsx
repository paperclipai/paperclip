// @vitest-environment jsdom

import type { ReactElement } from "react";
import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { TaskChatThread } from "./TaskChatThread";
import type {
  IssueDocument,
  IssueQueuedCommentQueue,
  IssueThreadInteraction,
} from "@paperclipai/shared";
import { heartbeatsApi } from "@/api/heartbeats";

const transcriptState = vi.hoisted(() => ({
  transcriptByRun: new Map(),
  isInitialHydrating: false,
}));
const nativeTranscriptState = vi.hoisted(() => ({
  transcriptByRun: new Map(),
  errorsByRun: new Map(),
}));
const transcriptHookRuns = vi.hoisted(() => ({ legacy: [] as unknown[][], native: [] as unknown[][] }));
const sidebarState = vi.hoisted(() => ({ isMobile: false }));
const planState = vi.hoisted(() => ({ data: null as IssueDocument | null }));
const DIRECT_ADAPTER_TYPES = [
  "codex_local",
  "claude_local",
  "opencode_local",
  "process",
  "http",
  "custom_plugin",
] as const;

vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: ({ runs }: { runs: unknown[] }) => {
    transcriptHookRuns.legacy.push(runs);
    return {
      transcriptByRun: new Map(transcriptState.transcriptByRun),
      isInitialHydrating: transcriptState.isInitialHydrating,
    };
  },
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: (runs: unknown[]) => {
    transcriptHookRuns.native.push(runs);
    return {
      transcriptByRun: new Map(nativeTranscriptState.transcriptByRun),
      errorsByRun: new Map(nativeTranscriptState.errorsByRun),
    };
  },
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: sidebarState.isMobile }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => planState,
}));
vi.mock("@/lib/router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string;
    children: React.ReactNode;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor(
    { value }: { value: string },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({
      insertMarkdown: () => {},
      focus: () => {},
    }));
    return <div data-testid="mock-editor">{value}</div>;
  }),
}));

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  transcriptState.transcriptByRun.clear();
  transcriptState.isInitialHydrating = false;
  nativeTranscriptState.transcriptByRun.clear();
  nativeTranscriptState.errorsByRun.clear();
  transcriptHookRuns.legacy.length = 0;
  transcriptHookRuns.native.length = 0;
  sidebarState.isMobile = false;
  planState.data = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

function render(ui: ReactElement) {
  flushSync(() => root!.render(<ThemeProvider>{ui}</ThemeProvider>));
}

function fakeScrollGeometry(
  element: HTMLElement,
  { scrollHeight = 1000, clientHeight = 400, scrollTop = 600 } = {},
) {
  let currentScrollTop = scrollTop;
  Object.defineProperty(element, "scrollHeight", {
    value: scrollHeight,
    configurable: true,
  });
  Object.defineProperty(element, "clientHeight", {
    value: clientHeight,
    configurable: true,
  });
  Object.defineProperty(element, "scrollTop", {
    get: () => currentScrollTop,
    set: (value: number) => {
      currentScrollTop = value;
    },
    configurable: true,
  });
}

function planDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-plan",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "# Preview the Plan\n- Reuse the review card.\n- Stream live steps.\n- Reconcile the revision.",
    latestRevisionId: "revision-3",
    latestRevisionNumber: 3,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt: new Date("2026-08-23T10:00:00.000Z"),
    updatedAt: new Date("2026-08-23T10:01:00.000Z"),
    ...overrides,
  };
}

function planReviewInteraction(
  status: "pending" | "accepted" | "expired" = "pending",
  revisionId = "revision-3",
  sourceRunId: string | null = "run-plan",
): IssueThreadInteraction {
  const isResolved = status !== "pending";
  return {
    id: "plan-review",
    companyId: "company-1",
    issueId: "issue-1",
    kind: "request_confirmation",
    title: "Review the Plan",
    summary: null,
    status,
    continuationPolicy: "wake_assignee",
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    sourceRunId,
    resolvedByAgentId: null,
    resolvedByUserId: isResolved ? "user-1" : null,
    createdAt: new Date("2026-08-23T10:01:01.000Z"),
    updatedAt: new Date("2026-08-23T10:01:01.000Z"),
    resolvedAt: isResolved ? new Date("2026-08-23T10:02:00.000Z") : null,
    payload: {
      version: 1,
      prompt: "Approve this Plan?",
      target: {
        type: "issue_document",
        issueId: "issue-1",
        documentId: "document-plan",
        key: "plan",
        revisionId,
        revisionNumber: 3,
        label: "Plan revision 3",
      },
    },
    result:
      status === "accepted"
        ? { outcome: "accepted" }
        : status === "expired"
          ? {
              outcome: "superseded_by_comment",
              commentId: "follow-up-comment",
            }
          : null,
  } as IssueThreadInteraction;
}

function questionInteraction(
  id: string,
  prompt: string,
  createdAt: string,
): IssueThreadInteraction {
  return {
    id,
    companyId: "company-1",
    issueId: "issue-1",
    kind: "ask_user_questions",
    title: prompt,
    status: "pending",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "anyone",
    requestedResolverPolicy: "anyone",
    effectiveResolverPolicy: "anyone",
    resolverPolicyProvenance: "inherited",
    effectiveResolverPolicySource: "requested",
    legacyResolverPolicyAliases: {
      requested: "board_or_agents",
      effective: "board_or_agents",
    },
    createdByAgentId: "agent-1",
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    resolvedAt: null,
    payload: {
      version: 1,
      questions: [
        {
          id: `${id}-question`,
          prompt,
          selectionMode: "single",
          required: true,
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
        },
      ],
    },
    result: null,
  } as IssueThreadInteraction;
}

describe("TaskChatThread draft pass-through", () => {
  it("aligns the desktop thread header with the side-panel tab row", () => {
    render(
      <TaskChatThread
        comments={[
          {
            id: "comment-1",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "Header alignment fixture.",
            presentation: null,
            metadata: null,
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            updatedAt: new Date("2026-08-15T12:00:00.000Z"),
          },
        ]}
        onAdd={async () => {}}
      />,
    );

    const scroller = container.querySelector(
      '[data-testid="task-chat-scroller"]',
    );
    expect(scroller?.firstElementChild?.classList).toContain("pt-3");
  });

  it("keeps the composer dock aligned with the thread's horizontal padding", () => {
    render(
      <TaskChatThread
        comments={[
          {
            id: "comment-1",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "Waiting for the dependency.",
            presentation: null,
            metadata: null,
            createdAt: new Date("2026-08-15T12:00:00.000Z"),
            updatedAt: new Date("2026-08-15T12:00:00.000Z"),
          },
        ]}
        onAdd={async () => {}}
      />,
    );

    const dock = container.querySelector(
      '[data-testid="task-chat-composer-dock"]',
    );
    expect(dock?.classList).toContain("px-4");
    expect(dock?.classList).not.toContain("px-1");
  });

  it("forwards draftKey so the composer restores a task's saved draft", () => {
    localStorage.setItem("task-chat-draft:issue-1", "half-written thought");

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        draftKey="task-chat-draft:issue-1"
      />,
    );

    expect(
      container.querySelector('[data-testid="mock-editor"]')?.textContent,
    ).toBe("half-written thought");
  });

  it("forwards human profiles to the selected composer assignee", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        enableReassign
        reassignOptions={[{ id: "user:user-1", label: "Riley Board" }]}
        currentAssigneeValue="user:user-1"
        userProfileMap={
          new Map([
            ["user-1", { label: "Riley Board", image: "/riley-avatar.png" }],
          ])
        }
      />,
    );

    expect(
      container.querySelector('[data-assignee-trigger-avatar="user-1"]'),
    ).not.toBeNull();
  });
});

describe("TaskChatThread runtime transcript selection", () => {
  it("selects persisted runtime facts while retaining the log parser as native fallback", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        linkedRuns={[
          {
            runId: "native-run",
            runtimeMode: "native",
            status: "succeeded",
            agentId: "agent-1",
            adapterType: "paperclip_runner",
            createdAt: "2026-08-25T18:00:00.000Z",
            startedAt: "2026-08-25T18:00:00.000Z",
          },
          ...DIRECT_ADAPTER_TYPES.map((adapterType, index) => ({
            runId: `legacy-run-${index}`,
            runtimeMode: "legacy" as const,
            status: "succeeded",
            agentId: `agent-${index + 2}`,
            adapterType,
            createdAt: `2026-08-25T18:0${index + 1}:00.000Z`,
            startedAt: `2026-08-25T18:0${index + 1}:00.000Z`,
          })),
        ]}
      />,
    );

    const legacyRuns = transcriptHookRuns.legacy.at(-1) as Array<{ id: string }>;
    const nativeRuns = transcriptHookRuns.native.at(-1) as Array<{ id: string }>;
    expect(legacyRuns.map((run) => run.id)).toEqual([
      "native-run",
      ...DIRECT_ADAPTER_TYPES.map((_, index) => `legacy-run-${index}`),
    ]);
    expect(nativeRuns.map((run) => run.id)).toEqual(["native-run"]);
  });

  it("uses runner-only controls only for an actual native Paperclip Runner run", () => {
    nativeTranscriptState.transcriptByRun.set("native-run", [
      {
        kind: "assistant",
        ts: "2026-08-25T18:00:01.000Z",
        text: "Checking the task.",
        channel: "progress",
      },
      {
        kind: "assistant",
        ts: "2026-08-25T18:00:02.000Z",
        text: "The task is ready.",
        channel: "final",
      },
    ]);

    const run = {
      id: "native-run",
      runtimeMode: "native" as const,
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-25T18:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-25T18:00:00.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={run}
      />,
    );

    expect(container.querySelector('[data-testid="task-chat-runner-turn"]')).not.toBeNull();
    expect(container.textContent).toContain("Checking the task.");
    expect(container.textContent).toContain("The task is ready.");

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{ ...run, runtimeMode: "legacy" }}
      />,
    );

    expect(container.querySelector('[data-testid="task-chat-runner-turn"]')).toBeNull();

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{ ...run, adapterType: "codex_local" }}
      />,
    );

    expect(container.querySelector('[data-testid="task-chat-runner-turn"]')).toBeNull();
  });

  it("uses the live log when a native run has no persisted event transcript", () => {
    transcriptState.transcriptByRun.set("native-run", [
      {
        kind: "assistant",
        ts: "2026-08-25T18:00:01.000Z",
        text: "Visible from the runner log fallback.",
        channel: "progress",
      },
    ]);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "native-run",
          runtimeMode: "native",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-25T18:00:00.000Z",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
        }}
      />,
    );

    expect(container.textContent).toContain("Visible from the runner log fallback.");
  });

  it("uses a fresher live log when native event polling fails after earlier events", () => {
    nativeTranscriptState.transcriptByRun.set("native-run", [
      {
        kind: "assistant",
        ts: "2026-08-25T18:00:01.000Z",
        text: "Stale native activity.",
        channel: "progress",
      },
    ]);
    nativeTranscriptState.errorsByRun.set("native-run", {
      message: "event endpoint unavailable",
      failedAt: "2026-08-25T18:00:02.000Z",
    });
    transcriptState.transcriptByRun.set("native-run", [
      {
        kind: "assistant",
        ts: "2026-08-25T18:00:03.000Z",
        text: "Fresh activity from the runner log.",
        channel: "progress",
      },
    ]);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "native-run",
          runtimeMode: "native",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-25T18:00:00.000Z",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
        }}
      />,
    );

    expect(container.textContent).toContain("Fresh activity from the runner log.");
    expect(container.textContent).not.toContain("Stale native activity.");
    expect(container.textContent).not.toContain("temporarily unavailable");
  });

  it("keeps legacy channel-less native messages readable across settlement", () => {
    nativeTranscriptState.transcriptByRun.set("native-run", [
      {
        kind: "assistant",
        ts: "2026-08-25T18:00:01.000Z",
        text: "Persisted before message channels existed.",
        channel: "unknown",
      },
    ]);

    const run = {
      id: "native-run",
      runtimeMode: "native" as const,
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-25T18:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-25T18:00:00.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={run}
      />,
    );

    expect(container.querySelector('[data-testid="task-chat-phase-interstitial"]')?.textContent)
      .toContain("Persisted before message channels existed.");
    expect(container.querySelector('[data-testid="task-chat-final-response"]')).toBeNull();

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="done"
        activeRun={{ ...run, status: "succeeded", finishedAt: "2026-08-25T18:00:02.000Z" }}
      />,
    );

    expect(container.querySelector('[data-testid="task-chat-phase-interstitial"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.textContent)
      .toContain("Persisted before message channels existed.");
  });

  it("recomputes a runner turn when only the message channel changes", () => {
    const run = {
      id: "native-run",
      runtimeMode: "native" as const,
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-25T18:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-25T18:00:00.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
    };
    const renderRun = () => render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={run}
      />,
    );

    nativeTranscriptState.transcriptByRun.set("native-run", [{
      kind: "assistant",
      ts: "2026-08-25T18:00:01.000Z",
      text: "Same text.",
      channel: "progress",
    }]);
    renderRun();
    expect(container.querySelector('[data-testid="task-chat-phase-interstitial"]')?.textContent)
      .toContain("Same text.");
    expect(container.querySelector('[data-testid="task-chat-final-response"]')).toBeNull();

    nativeTranscriptState.transcriptByRun.set("native-run", [{
      kind: "assistant",
      ts: "2026-08-25T18:00:01.000Z",
      text: "Same text.",
      channel: "final",
    }]);
    renderRun();
    expect(container.querySelector('[data-testid="task-chat-phase-interstitial"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-final-response"]')?.textContent)
      .toContain("Same text.");
  });

  it("recomputes a runner turn when only usage totals change", () => {
    const run = {
      id: "native-run",
      runtimeMode: "native" as const,
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-25T18:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-25T18:00:00.000Z",
      agentId: "agent-1",
      agentName: "Runner",
      adapterType: "paperclip_runner",
    };
    const usageEntry = (inputTokens: number) => ({
      kind: "result" as const,
      ts: "2026-08-25T18:00:01.000Z",
      text: "",
      inputTokens,
      outputTokens: 5,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "paperclip_runner_usage",
      isError: false,
      errors: [],
    });
    const renderRun = () => render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={run}
      />,
    );
    const revealUsage = () => {
      const summary = container.querySelector<HTMLButtonElement>(
        '[data-testid="task-chat-phase-summary"]',
      );
      expect(summary).not.toBeNull();
      if (summary?.getAttribute("aria-expanded") !== "true") {
        flushSync(() => summary!.click());
      }
    };

    nativeTranscriptState.transcriptByRun.set("native-run", [usageEntry(10)]);
    renderRun();
    revealUsage();
    expect(container.textContent).toContain("↑10");

    nativeTranscriptState.transcriptByRun.set("native-run", [usageEntry(20)]);
    renderRun();
    revealUsage();
    expect(container.textContent).toContain("↑20");
    expect(container.textContent).not.toContain("↑10");
  });
  it.each(DIRECT_ADAPTER_TYPES)(
    "keeps active %s output on the legacy live-tail surface",
    (adapterType) => {
      const runId = `active-${adapterType}`;
      transcriptState.transcriptByRun.set(runId, [
        {
          kind: "assistant",
          ts: "2026-08-25T18:00:01.000Z",
          text: `Active ${adapterType} output`,
        },
      ]);

      render(
        <TaskChatThread
          comments={[]}
          onAdd={async () => {}}
          issueStatus="in_progress"
          activeRun={{
            id: runId,
            runtimeMode: "legacy",
            status: "running",
            invocationSource: "issue",
            triggerDetail: null,
            startedAt: "2026-08-25T18:00:00.000Z",
            finishedAt: null,
            createdAt: "2026-08-25T18:00:00.000Z",
            agentId: "agent-1",
            agentName: "Direct agent",
            adapterType,
          }}
        />,
      );

      expect(
        container.querySelector('[data-testid="task-chat-live-run-pill"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-phase-interstitial"]')
          ?.textContent,
      ).toContain(`Active ${adapterType} output`);
      expect(
        container.querySelector('[data-testid="task-chat-runner-turn"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-queued-messages"]'),
      ).toBeNull();
    },
  );

  it.each(DIRECT_ADAPTER_TYPES)(
    "keeps settled %s activity in the shared legacy turn",
    (adapterType) => {
      const runId = `settled-${adapterType}`;
      transcriptState.transcriptByRun.set(runId, [
        {
          kind: "tool_call",
          ts: "2026-08-25T18:00:01.000Z",
          name: "Read",
          toolUseId: `${runId}-tool`,
          input: { file_path: "src/legacy.ts" },
        },
        {
          kind: "tool_result",
          ts: "2026-08-25T18:00:02.000Z",
          toolUseId: `${runId}-tool`,
          toolName: "Read",
          content: "legacy contents",
          isError: false,
        },
      ]);

      render(
        <TaskChatThread
          comments={[]}
          onAdd={async () => {}}
          linkedRuns={[
            {
              runId,
              runtimeMode: "legacy",
              status: "succeeded",
              agentId: "agent-1",
              agentName: "Direct agent",
              adapterType,
              createdAt: "2026-08-25T18:00:00.000Z",
              startedAt: "2026-08-25T18:00:00.000Z",
              finishedAt: "2026-08-25T18:00:03.000Z",
            },
          ]}
        />,
      );

      expect(
        container.querySelector('[data-testid="task-chat-turn"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-turn-summary"]')
          ?.textContent,
      ).toContain("Worked");
      expect(
        container.querySelector('[data-testid="task-chat-runner-turn"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-final-response"]'),
      ).toBeNull();
    },
  );

  it.each(DIRECT_ADAPTER_TYPES)(
    "keeps an empty active %s run on the legacy status surface",
    (adapterType) => {
      render(
        <TaskChatThread
          comments={[]}
          onAdd={async () => {}}
          issueStatus="in_progress"
          activeRun={{
            id: `empty-${adapterType}`,
            runtimeMode: "legacy",
            status: "running",
            invocationSource: "issue",
            triggerDetail: null,
            currentStatusMessage: "Preparing direct runtime",
            startedAt: "2026-08-25T18:00:00.000Z",
            finishedAt: null,
            createdAt: "2026-08-25T18:00:00.000Z",
            agentId: "agent-1",
            agentName: "Direct agent",
            adapterType,
          }}
        />,
      );

      const tail = container.querySelector(
        '[data-testid="task-chat-live-transcript"]',
      );
      expect(tail?.textContent).toContain("Preparing direct runtime");
      expect(
        container.querySelector('[data-testid="task-chat-runner-turn"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-composer-takeover"]'),
      ).toBeNull();
    },
  );

  it.each(DIRECT_ADAPTER_TYPES)(
    "keeps durable questions usable for an active %s run without runner controls",
    (adapterType) => {
      render(
        <TaskChatThread
          comments={[]}
          interactions={[
            questionInteraction(
              `question-${adapterType}`,
              "Which legacy path should continue?",
              "2026-08-25T18:00:01.000Z",
            ),
          ]}
          onAdd={async () => {}}
          onSubmitInteractionAnswers={async () => {}}
          issueStatus="in_progress"
          activeRun={{
            id: `question-run-${adapterType}`,
            runtimeMode: "legacy",
            status: "running",
            invocationSource: "issue",
            triggerDetail: null,
            startedAt: "2026-08-25T18:00:00.000Z",
            finishedAt: null,
            createdAt: "2026-08-25T18:00:00.000Z",
            agentId: "agent-1",
            agentName: "Direct agent",
            adapterType,
          }}
        />,
      );

      expect(
        container.querySelector('[data-testid="task-chat-composer-takeover"]')
          ?.textContent,
      ).toContain("Which legacy path should continue?");
      expect(
        container.querySelector('[data-testid="task-chat-runner-turn"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-queued-messages"]'),
      ).toBeNull();
    },
  );
});

describe("TaskChatThread composer alignment", () => {
  it("matches the thread width at every breakpoint", () => {
    render(<TaskChatThread comments={[]} onAdd={async () => {}} />);

    const dock = container
      .querySelector('[data-testid="mock-editor"]')
      ?.closest("div.sticky") as HTMLElement | null;

    expect(dock?.className).toContain("w-full");
    expect(dock?.className).toContain("max-w-(--tc-shell-max-w)");
    expect(dock?.className).not.toContain("md:w-(--pct-80)");
  });
});

describe("TaskChatThread no-live-execution-path recovery", () => {
  const noLivePathComment = {
    id: "comment-no-live-path",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "system" as const,
    authorAgentId: null,
    authorUserId: null,
    body: "Paperclip retried continuation, but it still has no live execution path.",
    presentation: {
      kind: "system_notice" as const,
      tone: "danger" as const,
      title: "No live execution path",
      detailsDefaultOpen: false,
    },
    metadata: null,
    createdAt: new Date("2026-08-26T12:00:00.000Z"),
    updatedAt: new Date("2026-08-26T12:00:00.000Z"),
  };

  it("offers Try again only while the task is blocked", async () => {
    const onTryAgain = vi.fn();
    const props = {
      comments: [noLivePathComment],
      onAdd: async () => {},
      onTryAgainNoLiveExecutionPath: onTryAgain,
      showComposer: false,
    };

    render(<TaskChatThread {...props} issueStatus="blocked" />);
    const tryAgain = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-no-live-path-try-again"]',
    );
    expect(tryAgain).not.toBeNull();

    flushSync(() => tryAgain!.click());
    await Promise.resolve();
    expect(onTryAgain).toHaveBeenCalledTimes(1);

    render(<TaskChatThread {...props} issueStatus="todo" />);
    expect(container.querySelector('[data-testid="task-chat-no-live-path-try-again"]')).toBeNull();
  });
});

describe("TaskChatThread blocker links", () => {
  it("shows the direct and server-selected terminal blocker at the top and bottom", () => {
    const terminalBlocker = {
      id: "terminal-2",
      identifier: "PAP-777",
      title: "Actual work",
      status: "in_progress" as const,
      priority: "high" as const,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
    };
    const directBlocker = {
      id: "direct-2",
      identifier: "PAP-600",
      title: "Waiting in review",
      status: "in_review" as const,
      priority: "medium" as const,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      terminalBlockers: [terminalBlocker],
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Different dependency",
            status: "todo",
            priority: "low",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          directBlocker,
        ]}
        blockerAttention={{
          state: "needs_attention",
          reason: "attention_required",
          unresolvedBlockerCount: 2,
          coveredBlockerCount: 0,
          stalledBlockerCount: 0,
          attentionBlockerCount: 1,
          sampleBlockerIdentifier: "PAP-777",
          sampleStalledBlockerIdentifier: null,
          terminalBlockerIssueId: terminalBlocker.id,
        }}
      />,
    );

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-blocker-links"]',
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.getAttribute("data-placement")).toBe("top");
    expect(notices[1]?.getAttribute("data-placement")).toBe("bottom");
    for (const notice of notices) {
      expect(notice.textContent).toContain(
        "Blocked byPAP-600Waiting in review",
      );
      expect(notice.textContent).toContain(
        "Ultimately blocked byPAP-777Actual work",
      );
      expect(notice.querySelector('a[href="/issues/PAP-600"]')).not.toBeNull();
      expect(notice.querySelector('a[href="/issues/PAP-777"]')).not.toBeNull();
    }
    expect(container.textContent).not.toContain("Different dependency");
    expect(container.textContent).not.toContain(
      "This task resumes automatically",
    );
  });

  it("shows the ordered live-work queue at the top and bottom", () => {
    const terminalBlocker = {
      id: "terminal-running",
      identifier: "PAP-17426",
      title: "Restore live alias projection",
      status: "in_progress" as const,
      priority: "high" as const,
      assigneeAgentId: "agent-3",
      assigneeUserId: null,
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        liveIssueIds={new Set(["direct-running", "terminal-running"])}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 2,
          coveredBlockerCount: 2,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-17426",
          sampleStalledBlockerIdentifier: null,
          blockingTreeLive: true,
          directBlockerIssueId: "direct-running",
          terminalBlockerIssueId: terminalBlocker.id,
          terminalBlocker,
        }}
        blockedBy={[
          {
            id: "direct-queued",
            identifier: "PAP-17427",
            title: "Verify the completed projection",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-4",
            assigneeUserId: null,
          },
          {
            id: "direct-running",
            identifier: "PAP-17425",
            title: "Verify the live projection",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-2",
            assigneeUserId: null,
            terminalBlockers: [terminalBlocker],
          },
          {
            id: "direct-done",
            identifier: "PAP-17424",
            title: "Run the guarded cutover",
            status: "done",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-live-work-links"]',
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.getAttribute("data-placement")).toBe("top");
    expect(notices[1]?.getAttribute("data-placement")).toBe("bottom");
    for (const notice of notices) {
      expect(notice.textContent).toContain("Waiting on live work");
      const orderedLinks = [
        ...notice.querySelectorAll(
          '[data-testid="task-chat-live-work-step"] a',
        ),
      ].map((link) => link.textContent);
      expect(orderedLinks).toEqual([
        "PAP-17424Run the guarded cutover",
        "PAP-17425Verify the live projection",
        "PAP-17427Verify the completed projection",
      ]);
      expect(notice.textContent).toContain(
        "Now runningPAP-17426Restore live alias projection",
      );
      expect(
        notice.querySelector('a[href="/issues/PAP-17426"]'),
      ).not.toBeNull();
    }
    expect(
      container.querySelector('[data-testid="task-chat-blocker-links"]'),
    ).toBeNull();
  });

  it("keeps the compact blocker rows when covered work is no longer live", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        liveIssueIds={new Set()}
        blockerAttention={{
          state: "covered",
          reason: "active_dependency",
          unresolvedBlockerCount: 1,
          coveredBlockerCount: 1,
          stalledBlockerCount: 0,
          attentionBlockerCount: 0,
          sampleBlockerIdentifier: "PAP-500",
          sampleStalledBlockerIdentifier: null,
          blockingTreeLive: false,
        }}
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Direct dependency",
            status: "todo",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-live-work-links"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="task-chat-blocker-links"]'),
    ).toHaveLength(2);
  });

  it("shows only the direct row when the blocker has no deeper unresolved leaf", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Direct dependency",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(
      container.querySelectorAll('[data-testid="task-chat-blocker-links"]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain(
      "Blocked byPAP-500Direct dependency",
    );
    expect(container.textContent).not.toContain("Ultimately blocked by");
  });

  it("keeps a server-selected intermediate blocker on its direct chain", () => {
    const selectedIntermediate = {
      id: "intermediate-2",
      identifier: "PAP-650",
      title: "Stalled intermediate review",
    };
    const selectedDirect = {
      id: "direct-2",
      identifier: "PAP-600",
      title: "Selected dependency",
      status: "blocked" as const,
      priority: "medium" as const,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      terminalBlockers: [
        {
          id: "leaf-2",
          identifier: "PAP-700",
          title: "Deeper structural leaf",
          status: "todo" as const,
          priority: "medium" as const,
          assigneeAgentId: "agent-2",
          assigneeUserId: null,
        },
      ],
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="blocked"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Unrelated dependency",
            status: "todo",
            priority: "low",
            assigneeAgentId: null,
            assigneeUserId: null,
          },
          selectedDirect,
        ]}
        blockerAttention={{
          state: "stalled",
          reason: "stalled_review",
          unresolvedBlockerCount: 2,
          coveredBlockerCount: 0,
          stalledBlockerCount: 1,
          attentionBlockerCount: 1,
          sampleBlockerIdentifier: "PAP-650",
          sampleStalledBlockerIdentifier: "PAP-650",
          directBlockerIssueId: selectedDirect.id,
          terminalBlockerIssueId: selectedIntermediate.id,
          terminalBlocker: selectedIntermediate,
        }}
      />,
    );

    for (const notice of container.querySelectorAll(
      '[data-testid="task-chat-blocker-links"]',
    )) {
      expect(notice.textContent).toContain(
        "Blocked byPAP-600Selected dependency",
      );
      expect(notice.textContent).toContain(
        "Ultimately blocked byPAP-650Stalled intermediate review",
      );
    }
    expect(container.textContent).not.toContain("Unrelated dependency");
    expect(container.textContent).not.toContain("Deeper structural leaf");
  });

  it("auto-follows the new bottom blocker row when a pinned thread becomes blocked", () => {
    const comment = {
      id: "comment-1",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Waiting for the dependency.",
      presentation: null,
      metadata: null,
      createdAt: new Date("2026-08-15T12:00:00.000Z"),
      updatedAt: new Date("2026-08-15T12:00:00.000Z"),
    };
    const directBlocker = {
      id: "direct-1",
      identifier: "PAP-500",
      title: "Direct dependency",
      status: "in_progress" as const,
      priority: "medium" as const,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
    };
    const baseProps = {
      comments: [comment],
      onAdd: async () => {},
      blockedBy: [directBlocker],
    };

    render(<TaskChatThread {...baseProps} issueStatus="in_progress" />);
    const scroller = container.querySelector<HTMLElement>(
      '[data-testid="task-chat-scroller"]',
    )!;
    fakeScrollGeometry(scroller);

    render(<TaskChatThread {...baseProps} issueStatus="blocked" />);

    expect(scroller.scrollTop).toBe(scroller.scrollHeight);
  });

  it("does not show blocker rows outside the blocked state", () => {
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        blockedBy={[
          {
            id: "direct-1",
            identifier: "PAP-500",
            title: "Direct dependency",
            status: "in_progress",
            priority: "medium",
            assigneeAgentId: "agent-1",
            assigneeUserId: null,
          },
        ]}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-blocker-links"]'),
    ).toBeNull();
  });
});

describe("TaskChatThread queued message actions", () => {
  it("interrupts the exact run that a persisted queued message is waiting behind", () => {
    const onInterruptQueued = vi.fn(async () => {});
    const queuedComment = {
      id: "comment-queued",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "user" as const,
      authorAgentId: null,
      authorUserId: "user-1",
      body: "Use the latest requirements instead.",
      presentation: null,
      metadata: null,
      queueState: "queued" as const,
      queueTargetRunId: "run-active",
      createdAt: new Date("2026-08-14T12:00:00.000Z"),
      updatedAt: new Date("2026-08-14T12:00:00.000Z"),
    };

    render(
      <TaskChatThread
        comments={[queuedComment]}
        onAdd={async () => {}}
        onInterruptQueued={onInterruptQueued}
      />,
    );

    const interrupt = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Interrupt",
    );
    expect(container.textContent).toContain("Queued");
    expect(interrupt).not.toBeUndefined();

    flushSync(() => interrupt!.click());
    expect(onInterruptQueued).toHaveBeenCalledOnce();
    expect(onInterruptQueued).toHaveBeenCalledWith("run-active");
  });

  it("disables the action while the queued run is being interrupted", () => {
    render(
      <TaskChatThread
        comments={[
          {
            id: "comment-queued",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "Use the latest requirements instead.",
            presentation: null,
            metadata: null,
            clientStatus: "queued",
            queueTargetRunId: "run-active",
            createdAt: new Date("2026-08-14T12:00:00.000Z"),
            updatedAt: new Date("2026-08-14T12:00:00.000Z"),
          },
        ]}
        onAdd={async () => {}}
        onInterruptQueued={async () => {}}
        interruptingQueuedRunId="run-active"
      />,
    );

    const interrupting = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Interrupting…",
    );
    expect(interrupting).not.toBeUndefined();
    expect(interrupting?.disabled).toBe(true);
  });
});

describe("TaskChatThread Paperclip Runner queue", () => {
  const queuedComment = {
    id: "queued-prp-1",
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user" as const,
    authorAgentId: null,
    authorUserId: "user-1",
    body: "Render this queued message exactly once.",
    presentation: null,
    metadata: null,
    createdAt: new Date("2026-08-22T15:00:00.000Z"),
    updatedAt: new Date("2026-08-22T15:00:00.000Z"),
  };
  const queue: IssueQueuedCommentQueue = {
    issueId: "issue-1",
    queueId: "wake-1",
    state: "deferred",
    targetRunId: "run-1",
    revision: "revision-1",
    protocol: "paperclip_runner_v1",
    steeringDisposition: "available",
    entries: [
      { comment: queuedComment, position: 0, canEdit: true, canDiscard: true },
    ],
  };

  function occurrenceCount(text: string) {
    return container.textContent?.split(text).length! - 1;
  }

  it("suppresses the transcript echo until the queued entry is consumed", async () => {
    const props = {
      comments: [queuedComment],
      onAdd: async () => {},
      queuedCommentQueue: queue,
      onEditQueuedComment: async () => {},
      onReorderQueuedComments: async () => {},
      onSteerQueuedComment: async () => {},
      onDiscardQueuedComment: async () => {},
    };
    render(<TaskChatThread {...props} />);

    const stack = container.querySelector(
      '[data-testid="task-chat-composer-stack"]',
    );
    const queuePane = container.querySelector(
      '[data-testid="task-chat-queued-messages"]',
    );
    expect(queuePane?.parentElement).toBe(stack);
    expect(stack?.classList).not.toContain("gap-2");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-queued-prp-1"]',
      ),
    ).not.toBeNull();
    expect(occurrenceCount(queuedComment.body)).toBe(1);

    await act(async () => {
      render(
        <TaskChatThread
          {...props}
          queuedCommentQueue={{ ...queue, revision: "revision-2", entries: [] }}
        />,
      );
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-queued-prp-1"]',
      ),
    ).toBeNull();
    expect(occurrenceCount(queuedComment.body)).toBe(1);
  });
});

describe("TaskChatThread mobile composer dock (PAP-495)", () => {
  it("pins the composer to the nav-aware bottom offset so its action row clears the auto-hiding bottom nav", () => {
    sidebarState.isMobile = true;

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        draftKey="task-chat-draft:issue-mobile"
      />,
    );

    const dock = container
      .querySelector('[data-testid="mock-editor"]')
      ?.closest("div.sticky") as HTMLElement | null;

    expect(dock).not.toBeNull();
    // Bottom offset comes from --tc-composer-bottom (Layout raises it to the nav
    // height while the nav is on screen) — NOT the raw safe-area dock, which is
    // what let the nav occlude the action row before PAP-495.
    expect(dock?.className).toContain("bottom-(--tc-composer-bottom)");
    expect(dock?.className).not.toContain("bottom-(--sz-calc-8)");
  });
});

describe("TaskChatThread live transcript", () => {
  it("places the turn status island below composer accessories and hides it when the turn is terminal", () => {
    nativeTranscriptState.transcriptByRun.set("run-status", [
      {
        kind: "provider_activity",
        ts: "2026-08-24T12:00:01.000Z",
        family: "plan",
        eventType: "plan.updated",
        status: "running",
        title: "Plan",
        payload: {
          planId: "turn-1",
          steps: [
            { stepId: "one", body: "Inspect", status: "completed" },
            { stepId: "two", body: "Build", status: "in_progress" },
          ],
        },
      },
      {
        kind: "workspace_change",
        ts: "2026-08-24T12:00:02.000Z",
        changeSetId: "turn-1:workspace",
        revision: 1,
        source: "harness_reported",
        complete: false,
        files: [
          {
            path: "ui/src/App.tsx",
            operation: "modify",
            previousPath: null,
            additions: 4,
            deletions: 1,
            binary: false,
            diff: null,
          },
        ],
        totals: { files: 1, additions: 4, deletions: 1 },
        patchArtifactRef: null,
      },
    ]);
    const activeRun = {
      id: "run-status",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-24T12:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-24T12:00:00.000Z",
      agentId: "agent-1",
      agentName: "Codex",
      adapterType: "paperclip_runner",
      runtimeMode: "native" as const,
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={activeRun}
        composerAccessory={<div data-testid="composer-accessory">Monitor</div>}
      />,
    );

    const dock = container.querySelector(
      '[data-testid="task-chat-composer-dock"]',
    )!;
    const accessory = container.querySelector(
      '[data-testid="composer-accessory"]',
    )!;
    const island = container.querySelector(
      '[data-testid="task-chat-turn-status-island"]',
    )!;
    const stack = container.querySelector(
      '[data-testid="task-chat-composer-stack"]',
    )!;
    expect(island.textContent).toContain("Step 2 / 2");
    expect(island.textContent).toContain("1 file changed");
    expect(accessory.compareDocumentPosition(island)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(island.compareDocumentPosition(stack)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(dock.contains(island)).toBe(true);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          ...activeRun,
          status: "succeeded",
          finishedAt: "2026-08-24T12:01:00.000Z",
        }}
      />,
    );
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-island"]'),
    ).toBeNull();
  });

  it("keeps an unlinked persisted runner reply hidden while the live turn still owns that response", () => {
    nativeTranscriptState.transcriptByRun.set("run-runner", [
      {
        kind: "assistant",
        ts: "2026-08-21T15:44:20.000Z",
        text: "Completed the requested streaming test.",
        channel: "final",
        delta: true,
      },
    ]);
    const comment = {
      id: "comment-runner",
      companyId: "company-1",
      issueId: "issue-1",
      authorType: "agent" as const,
      authorAgentId: "agent-1",
      authorUserId: null,
      body: "Completed the requested streaming test.",
      presentation: null,
      metadata: null,
      runId: null,
      createdAt: new Date("2026-08-21T15:44:22.000Z"),
      updatedAt: new Date("2026-08-21T15:44:22.000Z"),
    };

    render(
      <TaskChatThread
        comments={[comment]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "run-runner",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-21T15:44:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-21T15:44:00.000Z",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          runtimeMode: "native",
        }}
      />,
    );

    expect(
      container.textContent?.match(/Completed the requested streaming test\./g),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="task-chat-agent-bubble"]'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();
  });

  it("surfaces the live runtime status while no transcript has streamed yet", () => {
    // Sandbox runs spend their first minutes in preparation phases (config
    // seed, workspace sync) with zero transcript entries. The tail must show
    // the run's runtime-progress status instead of an opaque wait message.
    const baseRun = {
      id: "run-prep",
      status: "running" as const,
      invocationSource: "issue" as const,
      triggerDetail: null,
      startedAt: "2026-08-07T00:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-08-07T00:00:00.000Z",
      agentId: "agent-1",
      agentName: "Coder",
      adapterType: "claude_local",
    };

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          ...baseRun,
          currentStatusMessage: "Syncing workspace to environment",
        }}
      />,
    );

    const tail = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail).not.toBeNull();
    expect(tail!.textContent).toContain("Syncing workspace to environment");
    expect(tail!.textContent).not.toContain("Waiting for transcript...");

    // Without a runtime status, the generic wait message still shows.
    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{ ...baseRun, id: "run-prep-2" }}
      />,
    );
    const tail2 = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail2!.textContent).toContain("Waiting for transcript...");
  });

  it("renders in-flight output through TaskChatLiveTail, dropping the debug plumbing (PAP-463 C1)", () => {
    // Interleave the exact noise the old RunTranscriptView tail surfaced (init
    // row, stdout/stderr/system dumps) with real content. Only the streamed
    // reply markdown and the tool row may reach the thread.
    transcriptState.transcriptByRun.set("run-1", [
      {
        kind: "init",
        ts: "2026-08-07T00:00:00.000Z",
        model: "claude",
        sessionId: "sess-INITMARKER",
      },
      {
        kind: "system",
        ts: "2026-08-07T00:00:00.000Z",
        text: "SYSTEMNOISE environment hint",
      },
      {
        kind: "stdout",
        ts: "2026-08-07T00:00:00.000Z",
        text: "STDOUTNOISE raw json dump",
      },
      {
        kind: "stderr",
        ts: "2026-08-07T00:00:00.000Z",
        text: "STDERRNOISE adapter timeout note",
      },
      {
        kind: "assistant",
        ts: "2026-08-07T00:00:00.000Z",
        text: "Streaming through the shared renderer",
      },
      {
        kind: "tool_call",
        ts: "2026-08-07T00:00:00.000Z",
        name: "Read",
        toolUseId: "t1",
        input: { file_path: "src/app.ts" },
      },
    ]);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "run-1",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-07T00:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-07T00:00:00.000Z",
          agentId: "agent-1",
          agentName: "Coder",
          adapterType: "codex_local",
        }}
      />,
    );

    const tail = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail).not.toBeNull();
    // Clean content survives: streamed reply markdown + compact phase summary.
    expect(tail!.textContent).toContain(
      "Streaming through the shared renderer",
    );
    const phaseSummary = tail!.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-phase-summary"]',
    );
    expect(phaseSummary?.getAttribute("aria-expanded")).toBe("true");
    expect(tail!.textContent).toContain("src/app.ts");
    // None of the debug plumbing reaches the thread.
    for (const noise of [
      "INITMARKER",
      "SYSTEMNOISE",
      "STDOUTNOISE",
      "STDERRNOISE",
    ]) {
      expect(container.textContent).not.toContain(noise);
    }
  });

  it("resolves a visible canonical input even while run adapter metadata is stale", async () => {
    transcriptState.transcriptByRun.set("run-input", [
      {
        kind: "runtime_request",
        ts: "2026-08-23T20:00:00.000Z",
        requestId: "question-1",
        requestKind: "runtime",
        turnId: "turn-1",
        requestType: "input",
        status: "pending",
        prompt: "Codex needs your input.",
        choices: [],
        fields: [],
        questionSet: {
          schema: "paperclip.question_set.v1",
          questions: [
            {
              id: "goal",
              prompt: "What should the server do?",
              required: true,
              answerMode: "single_select",
              options: [{ id: "api", label: "Starter API" }],
            },
          ],
        },
      },
    ]);
    const resolveRuntimeRequest = vi
      .spyOn(heartbeatsApi, "resolveRuntimeRequest")
      .mockResolvedValue({} as never);

    render(
      <TaskChatThread
        comments={[]}
        onAdd={async () => {}}
        issueStatus="in_progress"
        activeRun={{
          id: "run-input",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          startedAt: "2026-08-23T20:00:00.000Z",
          finishedAt: null,
          createdAt: "2026-08-23T20:00:00.000Z",
          agentId: "agent-1",
          agentName: "Runner",
          // Reproduces the lag that caused DOT-202: the transcript already has
          // a Paperclip request while the linked-run adapter classification is
          // still stale.
          adapterType: "codex_local",
        }}
      />,
    );

    const option = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Starter API"),
    );
    await act(async () => option?.click());
    const submit = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Submit answers",
    );
    await act(async () => submit?.click());

    expect(resolveRuntimeRequest).toHaveBeenCalledWith({
      runId: "run-input",
      requestId: "question-1",
      turnId: "turn-1",
      requestKind: "runtime",
      resolution: {
        action: "submit",
        response: {
          schema: "paperclip.question_response.v1",
          answers: { goal: { selectedOptionIds: ["api"] } },
        },
      },
    });
    expect(container.textContent).not.toContain("no longer attached");
  });

  it("keeps the transcript mounted through run settle until the settled turn renders (PAP-462 B4)", () => {
    transcriptState.transcriptByRun.set("run-1", [
      {
        kind: "assistant",
        ts: "2026-08-07T00:00:00.000Z",
        text: "Last words before the run stops",
      },
    ]);

    const liveProps = {
      comments: [] as never[],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
        id: "run-1",
        status: "running",
        invocationSource: "issue" as const,
        triggerDetail: null,
        startedAt: "2026-08-07T00:00:00.000Z",
        finishedAt: null,
        createdAt: "2026-08-07T00:00:00.000Z",
        agentId: "agent-1",
        agentName: "Coder",
        adapterType: "codex_local",
      },
    };

    render(<TaskChatThread {...liveProps} />);
    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();

    // The run settles: the issue goes terminal and the run reports succeeded, so
    // `liveRun` flips to null — but no reply comment has landed yet. The
    // transcript must NOT vanish; it stays mounted (now as a settled tail) until
    // its settled turn/comment renders.
    render(
      <TaskChatThread
        {...liveProps}
        issueStatus="done"
        activeRun={{
          ...liveProps.activeRun,
          status: "succeeded",
          finishedAt: "2026-08-07T00:01:00.000Z",
        }}
      />,
    );

    expect(
      container.querySelector('[data-testid="task-chat-live-transcript"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Last words before the run stops");
    // The pill has settled to its "Worked" state rather than flipping back to a
    // spinner while it waits for the reply comment.
    expect(container.textContent).toContain("Worked");
  });
});
