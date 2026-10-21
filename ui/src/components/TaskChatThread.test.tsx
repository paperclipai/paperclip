// @vitest-environment jsdom

import type { ComponentProps, ReactElement } from "react";
import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/context/ThemeContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TaskChatThread } from "./TaskChatThread";
import { IssueChatThread } from "./IssueChatThread";
import type {
  Agent,
  IssueDocument,
  IssueQueuedCommentQueue,
  IssueThreadInteraction,
  TaskBrowser,
} from "@paperclipai/shared";
import { heartbeatsApi } from "@/api/heartbeats";
import { nativeRunEventsToTranscript } from "./transcript/native-run-events";
import { pendingConnectionIntentInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import { TaskChatScrollNavigation } from "./task-chat/scroll-navigation";
import type { HeartbeatRunEvent } from "@paperclipai/shared";

const transcriptState = vi.hoisted(() => ({
  transcriptByRun: new Map(),
  isInitialHydrating: false,
  hydratedRunIds: undefined as Set<string> | undefined,
}));
const nativeTranscriptState = vi.hoisted(() => ({
  transcriptByRun: new Map(),
  errorsByRun: new Map(),
  hydratedRunIds: undefined as Set<string> | undefined,
  terminalHydratedRunIds: undefined as Set<string> | undefined,
}));
const transcriptHookRuns = vi.hoisted(() => ({
  legacy: [] as unknown[][],
  native: [] as unknown[][],
}));
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
const editorCallbacks = vi.hoisted(() => ({ change: (_value: string) => {} }));
const streamlinedState = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: ({ runs }: { runs: unknown[] }) => {
    transcriptHookRuns.legacy.push(runs);
    return {
      transcriptByRun: new Map(transcriptState.transcriptByRun),
      isInitialHydrating: transcriptState.isInitialHydrating,
      hydratedRunIds: transcriptState.hydratedRunIds,
    };
  },
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: (runs: { id: string; status: string }[]) => {
    transcriptHookRuns.native.push(runs);
    return {
      transcriptByRun: new Map(nativeTranscriptState.transcriptByRun),
      errorsByRun: new Map(nativeTranscriptState.errorsByRun),
      hydratedRunIds: nativeTranscriptState.hydratedRunIds,
      terminalHydratedRunIds: nativeTranscriptState.terminalHydratedRunIds ??
        new Set(runs.filter((run) => run.status !== "running" && run.status !== "queued").map((run) => run.id)),
    };
  },
}));
vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: sidebarState.isMobile }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({
  useIssuePlanDocument: () => planState,
}));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({
    enabled: streamlinedState.enabled,
    loaded: true,
  }),
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues/issue", hash: "", search: "", key: "test", state: null }),
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
    { value, onChange }: { value: string; onChange: (value: string) => void },
    ref: ForwardedRef<unknown>,
  ) {
    useImperativeHandle(ref, () => ({
      insertMarkdown: () => {},
      focus: () => {},
    }));
    editorCallbacks.change = onChange;
    return <div data-testid="mock-editor">{value}</div>;
  }),
}));

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  localStorage.clear();
  transcriptState.transcriptByRun.clear();
  transcriptState.isInitialHydrating = false;
  transcriptState.hydratedRunIds = undefined;
  nativeTranscriptState.transcriptByRun.clear();
  nativeTranscriptState.errorsByRun.clear();
  nativeTranscriptState.hydratedRunIds = undefined;
  nativeTranscriptState.terminalHydratedRunIds = undefined;
  transcriptHookRuns.legacy.length = 0;
  transcriptHookRuns.native.length = 0;
  sidebarState.isMobile = false;
  planState.data = null;
  streamlinedState.enabled = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  root = null;
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

function render(ui: ReactElement) {
  flushSync(() =>
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>{ui}</ThemeProvider>
      </QueryClientProvider>,
    ),
  );
}

describe.each(["legacy", "native"] as const)("historical %s system status", (runtimeMode) => {
  const run = (id: string, status: string, minute: number) => ({
    runId: id, status, runtimeMode, agentId: "agent", agentName: "Assistant",
    adapterType: runtimeMode === "native" ? "paperclip_runner" : "claude_local",
    createdAt: `2025-01-01T10:0${minute}:00Z`, startedAt: `2025-01-01T10:0${minute}:01Z`,
    finishedAt: `2025-01-01T10:0${minute}:30Z`,
  });
  const comment = (id: string, body: string, runId?: string) => ({
    id, body, runId, companyId: "company", issueId: "issue", authorType: "agent" as const,
    authorAgentId: "agent", authorUserId: null, presentation: null, metadata: null,
    createdAt: new Date("2025-01-01T10:00:20Z"), updatedAt: new Date("2025-01-01T10:00:20Z"),
  });
  const setTranscript = (id: string) => {
    const state = runtimeMode === "native" ? nativeTranscriptState : transcriptState;
    state.transcriptByRun.set(id, [
      { kind: "assistant", channel: "progress", ts: "2025-01-01T10:00:02Z", text: "Inspected the source." },
      { kind: "tool_call", ts: "2025-01-01T10:00:03Z", name: "Read", input: { path: "README.md" }, toolUseId: "read" },
      { kind: "tool_result", ts: "2025-01-01T10:00:04Z", toolUseId: "read", content: "Source content" },
      { kind: "assistant", channel: "final", ts: "2025-01-01T10:00:20Z", text: "Saved the useful response." },
    ]);
  };

  it.each([true, false].flatMap(streamlined => ["done", "cancelled"].map(issueStatus => ({ streamlined, issueStatus }))))("removes failures, stops, waits and stored notices on $issueStatus tasks (streamlined=$streamlined)", ({ streamlined, issueStatus }) => {
    streamlinedState.enabled = streamlined;
    setTranscript("failed");
    const pausedAgent = { id: "agent", name: "Assistant", status: "paused", pauseReason: "manual" } as Agent;
    const props = {
      agentMap: new Map([[pausedAgent.id, pausedAgent]]),
      currentAssigneeValue: `agent:${pausedAgent.id}`,
      onResumeAssignee: vi.fn(),
      comments: [
        comment("response", "Saved the useful response.", "failed"),
        { ...comment("notice", "The previous execution needs to be checked.", "failed"), authorType: "system" as const,
          presentation: { kind: "system_notice" as const, tone: "warning" as const, title: "Recovery pending", detailsDefaultOpen: true } },
        { ...comment("human", "Please keep this message."), authorType: "user" as const, authorAgentId: null, authorUserId: "board" },
        { ...comment("session", "/new"), conversationSessionGeneration: 1 },
      ],
      linkedRuns: [run("failed", "failed", 0), run("stopped", "cancelled", 1),
        { ...run("wait", "cancelled", 2), startedAt: null, errorCode: "execution_reconciliation_required" },
        run("empty-success", "succeeded", 3)],
      onAdd: async () => {},
    };
    render(<TaskChatThread {...props} issueStatus="blocked" />);
    expect(container.querySelector('[data-testid="issue-assignee-paused-notice"]')).not.toBeNull();
    render(<TaskChatThread {...props} issueStatus={issueStatus} />);
    expect(container.querySelector('[data-testid="issue-assignee-paused-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="issue-assignee-paused-resume"]')).toBeNull();
    expect(container.textContent).toContain("Saved the useful response.");
    expect(container.textContent).toContain("Please keep this message.");
    expect(container.textContent).toContain("New session");
    for (const status of ["Run failed", "Stopped", "Worked", "Run cancelled", "Waiting to resume", "Recovery pending", "Run completed", "previous execution needs"]) {
      expect(container.textContent).not.toContain(status);
    }
    if (runtimeMode === "legacy") {
      const activity = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.startsWith("Activity"));
      expect(activity).toBeDefined();
      flushSync(() => activity!.click());
      expect(container.textContent).toContain("Inspected the source.");
    } else {
      expect(container.textContent).toContain("Inspected the source.");
    }
    expect(props.linkedRuns[0].status).toBe("failed");
    expect(props.comments).toHaveLength(4);
    render(<TaskChatThread {...props} issueStatus="todo" />);
    expect(container.querySelector('[data-testid="issue-assignee-paused-notice"]')).not.toBeNull();
    expect(pausedAgent.status).toBe("paused");
    expect(props.onResumeAssignee).not.toHaveBeenCalled();
  });

  it("replaces old failure and wait notices when a new attempt succeeds, regardless of fetch order", () => {
    setTranscript("old");
    const notice = { ...comment("notice", "Old recovery details."), authorType: "system" as const,
      metadata: { version: 1 as const, sourceRunId: "old", sections: [] } };
    const wait = { ...run("wait", "cancelled", 1), startedAt: null, errorCode: "execution_reconciliation_required" };
    const props = { comments: [notice, comment("response", "Saved the useful response.", "old")], onAdd: async () => {}, issueStatus: "in_progress" };
    render(<TaskChatThread {...props} linkedRuns={[run("old", "failed", 0), wait]} />);
    expect(container.textContent).toContain("Run failed");
    expect(container.textContent).toContain("Waiting to resume");
    for (const linkedRuns of [[run("new", "succeeded", 2), wait, run("old", "failed", 0)], [run("old", "failed", 0), wait, run("new", "succeeded", 2)]]) {
      render(<TaskChatThread {...props} linkedRuns={linkedRuns} />);
      expect(container.textContent).not.toContain("Run failed");
      expect(container.textContent).not.toContain("Waiting to resume");
      expect(container.textContent).not.toContain("Stopped");
      expect(container.querySelector('[data-testid="task-chat-system-notice"]')).toBeNull();
      expect(container.textContent).toContain("Saved the useful response.");
    }
  });

  it("keeps the latest failure actionable after hiding earlier errors", async () => {
    const retry = vi.fn();
    const linkedRuns = [run("new-failure", "failed", 2), run("old-failure", "failed", 0)];
    render(<TaskChatThread comments={[]} onAdd={async () => {}} issueStatus="blocked" linkedRuns={linkedRuns} onRetryFailedRun={retry} />);
    expect(container.textContent?.match(/Run failed/g)).toHaveLength(1);
    const button = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-run-failed-try-again"]');
    expect(button).not.toBeNull();
    flushSync(() => button!.click());
    await Promise.resolve();
    expect(retry).toHaveBeenCalledExactlyOnceWith("new-failure");
  });

  it.each(["in_progress", "done"])("preserves a child's stop relay after parent work (%s)", (issueStatus) => {
    const relay = { ...comment("child-relay", "System relay: [Child task](/issues/child) transitioned to `blocked`."),
      authorType: "system" as const, authorAgentId: null };
    render(<TaskChatThread comments={[relay]} onAdd={async () => {}} issueStatus={issueStatus}
      linkedRuns={[run("parent-follow-up", "succeeded", 1)]} />);
    expect(container.querySelector('[data-thread-anchor="child-relay"]')).not.toBeNull();
    expect(container.textContent).toContain("Child task");
  });

  it("clears old notices as soon as a successor is live, before history refreshes", () => {
    const old = run("old", "failed", 0);
    const live = { ...run("live", "running", 1), id: "live", finishedAt: null,
      invocationSource: "on_demand", triggerDetail: null };
    render(<TaskChatThread comments={[]} onAdd={async () => {}} issueStatus="in_progress"
      linkedRuns={[old]} activeRun={live} liveRuns={[live]} />);
    expect(container.textContent).not.toContain("Run failed");
    expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
  });

  it("does not carry an old failure into a successful same-agent activity summary", () => {
    setTranscript("old");
    setTranscript("new");
    const response = comment("new-response", "The follow-up succeeded.", "new");
    response.createdAt = new Date("2025-01-01T10:01:20Z");
    render(<TaskChatThread comments={[comment("old-response", "Saved the useful response.", "old"), response]}
      onAdd={async () => {}} issueStatus="in_progress" linkedRuns={[run("old", "failed", 0), run("new", "succeeded", 1)]} />);
    expect(container.textContent).toContain("The follow-up succeeded.");
    expect(container.textContent).toContain("Worked");
    expect(container.textContent).not.toContain("Stopped");
    expect(container.textContent).not.toContain("Run failed");
  });
});

it.each([true, false])("interleaves browser sessions with their requests and preserves position on status updates (streamlined=%s)", (streamlined) => {
  streamlinedState.enabled = streamlined;
  const onOpenBrowser = vi.fn();
  const comments = [0, 2, 4].map((minute) => ({
    id: `comment-${minute}`, companyId: "company", issueId: "issue",
    authorType: "user" as const, authorAgentId: null, authorUserId: "board",
    body: `Request at minute ${minute}`, presentation: null, metadata: null,
    createdAt: new Date(`2026-09-29T12:0${minute}:00Z`), updatedAt: new Date(`2026-09-29T12:0${minute}:00Z`),
  }));
  const browsers: TaskBrowser[] = [1, 3].map((minute) => ({
    id: `browser-${minute}`, sessionId: `session-${minute}`, issueId: "issue",
    status: "idle" as const, runStatus: "completed" as const, progress: null,
    costCents: 0, error: null, idleDeadline: null, expiresAt: null,
    createdAt: `2026-09-29T12:0${minute}:00Z`,
  }));
  const show = (next = browsers) => render(<TaskChatThread comments={comments} browsers={next} onOpenBrowser={onOpenBrowser} threadHeader={<div>Task title</div>} onAdd={async () => {}} />);
  show();
  const anchors = () => Array.from(container.querySelectorAll('[data-thread-anchor]')).map(el => el.getAttribute('data-thread-anchor'));
  const expected = ['comment-0', 'browser:session-1', 'comment-2', 'browser:session-3', 'comment-4'];
  expect(anchors()).toEqual(expected);
  expect(container.querySelector('[data-testid="task-chat-thread-header"]')?.textContent).toBe("Task title");
  const row = container.querySelector('[data-thread-anchor="browser:session-1"]');
  act(() => row?.querySelector<HTMLButtonElement>('button')?.click());
  expect(onOpenBrowser).toHaveBeenCalledWith('browser-1');
  // Provider IDs can become available after startup; session identity stays put.
  show([{ ...browsers[0], id: 'provider-browser-1', status: 'closed' }, browsers[1]]);
  expect(anchors()).toEqual(expected);
  expect(container.querySelector('[data-thread-anchor="browser:session-1"]')).toBe(row);
  expect(row?.textContent).toContain("View session");
  act(() => row?.querySelector<HTMLButtonElement>('button')?.click());
  expect(onOpenBrowser).toHaveBeenLastCalledWith('provider-browser-1');
  render(<TaskChatThread comments={comments.slice(1)} browsers={browsers} hasOlderComments onAdd={async () => {}} />);
  expect(anchors()).toEqual(['comment-2', 'browser:session-3', 'comment-4']);
  show();
  expect(anchors()).toEqual(expected);
});

it.each([true, false])("defers hidden content until history is ready and keeps it mounted through refresh (mobile=%s)", async (mobile) => {
  sidebarState.isMobile = mobile;
  const props = {
    issueId: "coordinated-issue",
    comments: [],
    onAdd: async () => {},
  };
  render(<TaskChatThread {...props} initialHistoryPending />);
  expect(container.querySelector('[data-testid="mock-editor"]')).toBeNull();
  expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(Boolean(container.querySelector('.task-chat-history-pending'))).toBe(mobile);
  expect(container.querySelector('[data-testid="task-chat-composer-dock"]')?.hasAttribute("inert")).toBe(true);
  render(<TaskChatThread {...props} initialHistoryPending={false} />);
  const composer = container.querySelector('[data-testid="mock-editor"]');
  expect(composer).not.toBeNull();
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
  expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
  expect(container.querySelector('.task-chat-history-pending')).toBeNull();
  expect(container.querySelector('[data-testid="task-chat-composer-dock"]')?.hasAttribute("inert")).toBe(false);
  expect(container.querySelector('[data-testid="mock-editor"]')).toBe(composer);
  render(<TaskChatThread {...props} initialHistoryPending />);
  expect(
    container.querySelector('[data-testid="task-chat-history-loading"]'),
  ).toBeNull();
  expect(container.querySelector('[data-testid="mock-editor"]')).toBe(composer);
  expect(container.querySelector('.task-chat-history-pending')).toBeNull();
});

it("defers initial history for a saved conversation with its own draft key", () => {
  render(<TaskChatThread comments={[]} onAdd={async () => {}} issueId="saved-chat"
    conversationMode draftKey="agent-chat:company:saved-agent" initialHistoryPending />);
  expect(container.querySelector('[data-testid="mock-editor"]')).toBeNull();
  expect(container.querySelector('[data-testid="task-chat-composer-dock"]')?.hasAttribute("inert")).toBe(true);
});

it.each([true, false])("keeps an upload attached when a conversation draft becomes a saved task (mobile=%s)", async (mobile) => {
  sidebarState.isMobile = mobile;
  const onAdd = vi.fn().mockResolvedValue(undefined);
  let resolveUpload!: (receipt: { id: string; contentPath: string; originalFilename: string }) => void;
  const onAttachImage = vi.fn().mockReturnValue(new Promise(resolve => { resolveUpload = resolve; }));
  const props = { comments: [], onAdd, onAttachImage, conversationMode: true, draftKey: "agent-chat:company:agent" };
  render(<TaskChatThread {...props} issueId="" />);
  const composer = container.querySelector('[data-testid="mock-editor"]');
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["notes"], "chat-notes.txt", { type: "text/plain" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(onAttachImage).toHaveBeenCalledExactlyOnceWith(file);
  expect(container.querySelector('[data-testid="task-chat-composer-attachments"]')?.textContent).toContain("chat-notes.txt");

  render(<TaskChatThread {...props} issueId="persisted-chat" initialHistoryPending />);
  expect(container.querySelector('[data-testid="mock-editor"]')).toBe(composer);
  expect(container.querySelector('[data-testid="task-chat-composer-attachments"]')?.textContent).toContain("chat-notes.txt");
  expect(onAdd).not.toHaveBeenCalled();
  const id = "9af8228f-0be7-45ae-a104-6fbe0af6f1d3";
  await act(async () => { resolveUpload({ id, contentPath: `/api/attachments/${id}/content`, originalFilename: file.name }); });
  render(<TaskChatThread {...props} issueId="persisted-chat" initialHistoryPending={false} />);
  await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
  const chip = container.querySelector('[data-testid="task-chat-composer-attachments"] [data-slot="attachment"]');
  expect(chip?.getAttribute("data-state")).toBe("done");
  const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')!;
  expect(send.disabled).toBe(false);
  await act(async () => { send.click(); });
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(onAdd.mock.calls[0]?.[0]).toBe(`[chat-notes.txt](/api/attachments/${id}/content)`);
  expect(onAdd.mock.calls[0]?.[3]).toEqual([id]);
});

it("shows Thinking during admission and clears it when the saved follow-up enters backoff", async () => {
  const pending = { id: "optimistic-recovery", companyId: "company", issueId: "issue", authorType: "user" as const,
    authorAgentId: null, authorUserId: "board", body: "Confirm the existing result.", presentation: null, metadata: null,
    createdAt: new Date(), updatedAt: new Date(), clientStatus: "pending" as const };
  const show = (accepted: boolean) => render(<TaskChatThread issueId="issue" issueStatus="blocked" executionBlocked
    comments={[{ ...pending, clientStatus: accepted ? "queued" : "pending" }]}
    interruption={accepted ? { intentId: "saved-input", responsibility: "system", state: "retry_scheduled",
      nextRetryAt: new Date(Date.now() + 30_000).toISOString(), canRetry: true, userAction: null,
      sourceRunIds: ["failed-run"], observedRunId: "failed-run" } : null}
    onAdd={async () => {}} issueAssigneeAgentId="agent"
    agentMap={new Map([["agent", { id: "agent", name: "Worker", adapterType: "paperclip_runner" } as Agent]])} />);
  show(false);
  expect(container.textContent).toContain("Confirm the existing result.");
  expect(container.textContent).toContain("Thinking");
  show(true);
  expect(container.textContent).not.toContain("Thinking");
  expect(container.textContent).not.toContain("Working");
});

it.each((["task", "legacy"] as const).flatMap(surface =>
  ([null, "failed", "resolved"] as const).map(previousState => ({ surface, previousState })),
))("keeps $surface admission Thinking through an old $previousState projection until acknowledgement", async ({ surface, previousState }) => {
  let acknowledge!: () => void;
  const onAdd = vi.fn(() => new Promise<void>(resolve => { acknowledge = resolve; }));
  const refresh = vi.fn();
  const Component = surface === "task" ? TaskChatThread : IssueChatThread;
  render(<Component comments={[]} issueId="issue" issueAssigneeAgentId="agent"
    issueStatus="todo" onAdd={onAdd} onRefreshLatestComments={refresh}
    interruption={previousState ? { intentId: "previous-intent", responsibility: "system", state: previousState,
      nextRetryAt: null, canRetry: previousState === "failed", userAction: null,
      sourceRunIds: ["previous-run"], observedRunId: "previous-run" } : null}
    agentMap={new Map([["agent", { id: "agent", name: "Worker", adapterType: "paperclip_runner" } as Agent]])} />);
  await act(async () => { editorCallbacks.change("Save this note."); });
  const send = surface === "task"
    ? container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]')
    : [...container.querySelectorAll("button")].find(button => button.textContent === "Send");
  expect(send).toBeDefined();
  vi.useFakeTimers();
  try {
    await act(async () => { send!.click(); });
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Thinking");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(container.textContent).toContain("Taking longer than usual");
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => { acknowledge(); });
    expect(container.textContent).not.toContain("Thinking");
    expect(container.textContent).not.toContain("Taking longer than usual");
  } finally {
    vi.useRealTimers();
  }
});

it("prepares comment-link history and its composer before reveal", async () => {
  const props = {
    issueId: "linked-issue",
    comments: createLongThreadComments(),
    onAdd: async () => {},
  };
  const show = (pending: boolean) => render(
    <TaskChatScrollNavigation.Provider value={{ key: "linked-entry", hash: "#comment-comment-1", restore: false }}>
      <TaskChatThread {...props} initialHistoryPending={pending} />
    </TaskChatScrollNavigation.Provider>,
  );
  show(true);
  const composer = container.querySelector('[data-testid="mock-editor"]');
  const row = container.querySelector('[data-thread-anchor="comment-1"]');
  expect(composer).not.toBeNull();
  expect(row).not.toBeNull();
  expect(row?.closest('[inert]')).not.toBeNull();
  show(false);
  await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
  expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
  expect(container.querySelector('[data-testid="mock-editor"]')).toBe(composer);
  expect(container.querySelector('[data-thread-anchor="comment-1"]')).toBe(row);
});

it.each([true, false])("reveals saved conversation when initial history stalls (mobile=%s)", async (mobile) => {
  vi.useFakeTimers();
  try {
    sidebarState.isMobile = mobile;
    const props = {
      issueId: "stalled-issue",
      comments: [{
        id: "saved-comment", body: "An already saved reply.", runId: null,
        companyId: "company", issueId: "stalled-issue", authorType: "agent" as const,
        authorAgentId: "agent", authorUserId: null, presentation: null, metadata: null,
        createdAt: new Date("2025-01-01T10:00:20Z"), updatedAt: new Date("2025-01-01T10:00:20Z"),
      }],
      onAdd: async () => {},
    };
    render(<TaskChatThread {...props} initialHistoryPending />);
    expect(container.querySelector('[data-testid="mock-editor"]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(14_999); });
    expect(container.querySelector('[data-testid="task-chat-history-loading"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const composer = container.querySelector('[data-testid="mock-editor"]');
    expect(composer).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-history-loading"]')).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-history-content"]')?.hasAttribute("inert")).toBe(false);
    expect(container.querySelector('[data-testid="task-chat-composer-dock"]')?.hasAttribute("inert")).toBe(false);
    expect(container.textContent).toContain("An already saved reply.");
    expect(container.textContent).toContain("Some task history is still loading.");
    expect(container.querySelector('[data-testid="mock-editor"]')).toBe(composer);
    render(<TaskChatThread {...props} initialHistoryPending={false} />);
    expect(container.textContent).not.toContain("Some task history is still loading.");
    expect(container.querySelector('[data-testid="mock-editor"]')).toBe(composer);

    // A timeout on one task must not bypass coordination on the next task.
    render(<TaskChatThread {...props} issueId="next-issue" initialHistoryPending />);
    expect(container.querySelector('[data-testid="task-chat-history-loading"]')).not.toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(container.querySelector('[data-testid="task-chat-history-loading"]')).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

describe.each(["legacy", "native"] as const)("%s task history readiness", (runtimeMode) => {
  const retryRun = {
    runId: "scheduled-run",
    runtimeMode,
    status: "scheduled_retry",
    agentId: "agent-1",
    adapterType: runtimeMode === "native" ? "paperclip_runner" : "codex_local",
    createdAt: "2026-08-25T18:00:00.000Z",
    startedAt: null,
  };

  beforeEach(() => {
    transcriptState.hydratedRunIds = new Set();
    nativeTranscriptState.hydratedRunIds = new Set();
  });

  it("reveals comments while a scheduled retry has no transcript to hydrate", () => {
    renderThread({
      issueId: "issue-1",
      comments: createLongThreadComments(),
      onAdd: async () => {},
      linkedRuns: [retryRun],
    });

    expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-history-loading"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-thread-anchor="comment-1"]')?.closest("[inert]"),
    ).toBeNull();
    expect(container.textContent).toContain("Thread message 1");
  });

  it("does not delay the first reveal for an older run outside the loaded comment window", () => {
    renderThread({
      issueId: "issue-1",
      comments: createLongThreadComments(),
      onAdd: async () => {},
      linkedRuns: [{
        ...retryRun,
        runId: "older-run",
        status: "succeeded",
        createdAt: "2026-08-01T12:00:00.000Z",
        startedAt: "2026-08-01T12:00:00.000Z",
        finishedAt: "2026-08-01T12:01:00.000Z",
      }],
    });
    expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
  });

  it.each(["running", "succeeded"])(
    "reveals durable comments together with a %s run's initial history",
    async (status) => {
      const props = {
        issueId: "issue-1",
        comments: [...createLongThreadComments(), {
          ...createLongThreadComments()[3],
          id: "agent-answer",
          authorType: "agent" as const,
          authorAgentId: "agent-1",
          body: "Final saved reply",
          runId: "started-run",
          createdAt: new Date("2026-08-25T18:00:02.000Z"),
        }],
        onAdd: async () => {},
        linkedRuns: [
          retryRun,
          {
            ...retryRun,
            runId: "started-run",
            status,
            startedAt: "2026-08-25T18:00:00.000Z",
          },
        ],
      };
      render(<TaskChatThread {...props} />);
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-history-loading"]'),
      ).not.toBeNull();
      expect(container.textContent).not.toContain("Thread message 1");
      expect(container.querySelector('[data-thread-anchor="comment-1"]')).toBeNull();
      transcriptState.hydratedRunIds = new Set(["started-run"]);
      nativeTranscriptState.hydratedRunIds = new Set(["started-run"]);
      transcriptState.transcriptByRun.set("started-run", [{
        kind: "thinking", text: "Reasoning before the reply",
        ts: "2026-08-25T18:00:01.000Z",
      }]);
      nativeTranscriptState.transcriptByRun.set("started-run", [{
        kind: "assistant", text: "Reasoning before the reply", channel: "progress",
        ts: "2026-08-25T18:00:01.000Z",
      }]);
      render(<TaskChatThread {...props} />);
      await act(async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      });

      expect(container.querySelector('[aria-busy="false"]')).not.toBeNull();
      expect(
        container.querySelector('[data-testid="task-chat-history-loading"]'),
      ).toBeNull();
      expect(container.querySelector('[data-thread-anchor="comment-1"]')?.closest('[inert]')).toBeNull();
      expect(container.textContent).toContain("Thread message 1");
      if (status === "succeeded" && runtimeMode === "native") {
        expect(container.textContent).toContain("Reasoning before the reply");
        expect(container.textContent).toContain("Final saved reply");
        expect(container.textContent!.indexOf("Reasoning before the reply")).toBeLessThan(
          container.textContent!.indexOf("Final saved reply"),
        );
      }
    },
  );
});

it("preserves the typed disposition notice through the task-chat adapter", () => {
  renderThread({
    comments: [{
      id: "typed-recovery", companyId: "company", issueId: "issue", authorType: "system", authorAgentId: null, authorUserId: null,
      body: "Unrelated prose", createdAt: new Date(), updatedAt: new Date(),
      presentation: { kind: "system_notice", title: "Different wording", tone: "warning", detailsDefaultOpen: false, density: "compact" },
      metadata: { version: 1, sections: [], recovery: { kind: "disposition_repair_escalated", actionId: "action", assigneeAgentId: "agent", attemptCount: 2, maxAttempts: 2, reason: "unchanged_source_state_exhausted" } },
    }],
    onAdd: async () => {},
    issueStatus: "blocked",
  });
  expect(container.querySelector('[data-testid="disposition-recovery-notice"]')).not.toBeNull();
  expect(container.textContent).toContain("Two automatic attempts");
  expect(container.textContent).not.toContain("Unrelated prose");
});

it("keeps an acknowledged optimistic bubble mounted with its canonical comment target", () => {
  const comment = {
    companyId: "company",
    issueId: "issue",
    authorAgentId: null,
    presentation: null,
    metadata: null,
    updatedAt: new Date("2026-09-09T12:00:00Z"),
    id: "optimistic-one",
    clientId: "optimistic-one",
    body: "Keep this message in place",
    authorType: "user" as const,
    authorUserId: "board",
    createdAt: new Date("2026-09-09T12:00:00Z"),
  };
  render(<TaskChatThread comments={[comment]} onAdd={async () => {}} />);
  const row = container.querySelector('[data-thread-anchor="optimistic-one"]');
  expect(row).not.toBeNull();
  renderThread({
    comments: [{ ...comment, id: "canonical-one" }],
    onAdd: async () => {},
  });
  expect(container.querySelector('[data-thread-anchor="optimistic-one"]')).toBe(
    row,
  );
  expect(row?.id).toBe("comment-canonical-one");
  expect(
    container.textContent?.match(/Keep this message in place/g),
  ).toHaveLength(1);
});

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

function createLongThreadComments() {
  return Array.from({ length: 4 }, (_, index) => ({
    id: `comment-${index + 1}`,
    companyId: "company-1",
    issueId: "issue-1",
    authorType: "user" as const,
    authorAgentId: null,
    authorUserId: "user-1",
    body: `Thread message ${index + 1}`,
    presentation: null,
    metadata: null,
    createdAt: new Date(`2026-08-15T12:0${index}:00.000Z`),
    updatedAt: new Date(`2026-08-15T12:0${index}:00.000Z`),
  }));
}

function assistantEntry(ts: string, text: string, channel: string) {
  return {
    kind: "assistant",
    ts: ts,
    text: text,
    channel: channel,
  };
}

function nativeRunningRun() {
  return {
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
}

function nativePlanRun(id: string): NonNullable<ComponentProps<typeof TaskChatThread>["activeRun"]> {
  return {
    id: id,
    status: "running",
    invocationSource: "issue",
    triggerDetail: null,
    startedAt: "2026-08-25T18:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-08-25T18:00:00.000Z",
    agentId: "agent-1",
    agentName: "Runner",
    adapterType: "paperclip_runner",
    runtimeMode: "native",
  };
}

function renderThread(props: ComponentProps<typeof TaskChatThread>) {
  render(<TaskChatThread {...props} />);
}

describe("TaskChatThread draft pass-through", () => {
  it("aligns the desktop thread header with the side-panel tab row", () => {
    renderThread({
      comments: [
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
      ],
      onAdd: async () => {},
    });

    const scroller = container.querySelector(
      '[data-testid="task-chat-scroller"]',
    );
    expect(scroller?.firstElementChild?.classList).toContain("pt-3");
  });

  it("lets the mobile composer dock use the full thread width", () => {
    renderThread({
      comments: [
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
      ],
      onAdd: async () => {},
    });

    const dock = container.querySelector(
      '[data-testid="task-chat-composer-dock"]',
    );
    const thread = container.querySelector('[data-testid="task-chat-thread"]');
    expect(thread?.classList).not.toContain("h-(--tc-thread-max-h)");
    expect(thread?.classList).toContain("flex-1");
    expect(dock?.classList).toContain("px-1");
    expect(dock?.classList).toContain("md:px-0");
    expect(dock?.classList).not.toContain("px-2");
    expect(dock?.classList).not.toContain("-mt-(--radius-task-composer)");
    expect(dock?.classList).not.toContain("pt-1");
    expect(dock?.classList).toContain("md:pb-0");
    expect(dock?.classList).not.toContain("md:pb-4");
    expect(dock?.classList).not.toContain("bg-background/80");
    expect(dock?.classList).not.toContain("backdrop-blur");
  });

  it("forwards draftKey so the composer restores a task's saved draft", () => {
    localStorage.setItem("task-chat-draft:issue-1", "half-written thought");

    renderThread({
      comments: createLongThreadComments(),
      onAdd: async () => {},
      draftKey: "task-chat-draft:issue-1",
    });

    expect(
      container.querySelector('[data-testid="mock-editor"]')?.textContent,
    ).toBe("half-written thought");
  });

  it("forwards human profiles to the selected composer assignee", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      enableReassign: true,
      reassignOptions: [{ id: "user:user-1", label: "Riley Board" }],
      currentAssigneeValue: "user:user-1",
      userProfileMap: new Map([
        ["user-1", { label: "Riley Board", image: "/riley-avatar.png" }],
      ]),
    });

    expect(
      container.querySelector('[data-assignee-trigger-avatar="user-1"]'),
    ).not.toBeNull();
  });
});

describe("TaskChatThread runtime transcript selection", () => {
  it.each(["queued", "running"])("retains the live log transport for a %s native run with event history", (status) => {
    nativeTranscriptState.hydratedRunIds = new Set(["native-run"]);
    nativeTranscriptState.transcriptByRun.set("native-run", [
      { kind: "assistant", text: "Native progress", ts: "2026-08-25T18:00:01.000Z", channel: "progress" },
    ]);
    const props = {
      issueId: "native-live", comments: [], onAdd: async () => {},
      linkedRuns: [{ runId: "native-run", runtimeMode: "native" as const,
        status, agentId: "agent-1", adapterType: "paperclip_runner",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: "2026-08-25T18:00:00.000Z" }],
    };
    render(<TaskChatThread {...props} />);
    expect(transcriptHookRuns.legacy.at(-1)).toMatchObject([{ id: "native-run", status }]);

    render(<TaskChatThread {...props} linkedRuns={[{ ...props.linkedRuns[0], status: "succeeded" }]} />);
    expect(transcriptHookRuns.legacy.at(-1)).toEqual([]);
  });

  it("does not download fallback logs until native events are empty or fail", () => {
    const props = {
      issueId: "native-history", comments: [], onAdd: async () => {},
      linkedRuns: [{ runId: "native-run", runtimeMode: "native" as const,
        status: "succeeded", agentId: "agent-1", adapterType: "paperclip_runner",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: "2026-08-25T18:00:00.000Z" }],
    };
    nativeTranscriptState.hydratedRunIds = new Set();
    render(<TaskChatThread {...props} />);
    expect(transcriptHookRuns.legacy.at(-1)).toEqual([]);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    nativeTranscriptState.hydratedRunIds = new Set(["native-run"]);
    nativeTranscriptState.transcriptByRun.set("native-run", [{ kind: "assistant", text: "Native response", ts: "2026-08-25T18:00:01.000Z", channel: "final" }]);
    render(<TaskChatThread {...props} />);
    expect(transcriptHookRuns.legacy.at(-1)).toEqual([]);

    nativeTranscriptState.transcriptByRun.clear();
    render(<TaskChatThread {...props} />);
    expect(transcriptHookRuns.legacy.at(-1)).toMatchObject([{ id: "native-run" }]);

    nativeTranscriptState.hydratedRunIds = new Set();
    nativeTranscriptState.errorsByRun.set("native-run", { message: "Unavailable" });
    render(<TaskChatThread {...props} />);
    expect(transcriptHookRuns.legacy.at(-1)).toMatchObject([{ id: "native-run" }]);
  });

  it("selects persisted runtime facts while retaining the log parser as native fallback", () => {
    nativeTranscriptState.hydratedRunIds = new Set(["native-run"]);
    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [
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
        ],
    });

    const legacyRuns = transcriptHookRuns.legacy.at(-1) as Array<{
      id: string;
    }>;
    const nativeRuns = transcriptHookRuns.native.at(-1) as Array<{
      id: string;
    }>;
    expect(legacyRuns.map((run) => run.id)).toEqual([
      "native-run",
      ...DIRECT_ADAPTER_TYPES.map((_, index) => `legacy-run-${index}`),
    ]);
    expect(nativeRuns.map((run) => run.id)).toEqual(["native-run"]);
  });

  it.each([false, true])("keeps the runner identity and activity mounted through startup (mobile=%s)", (mobile) => {
    sidebarState.isMobile = mobile;
    const run = nativeRunningRun();
    const comment = {
      id: "startup-message", companyId: "company", issueId: "issue",
      authorType: "user" as const, authorUserId: "board", authorAgentId: null,
      body: "Check the sandbox configuration.",
      presentation: null, metadata: null,
      createdAt: new Date(), updatedAt: new Date(),
    };
    const props = {
      comments: [comment], onAdd: async () => {}, issueStatus: "in_progress",
      currentUserId: "board", issueAssigneeAgentId: "agent-1",
      agentMap: new Map([["agent-1", { id: "agent-1", name: "Runner", adapterType: "paperclip_runner", icon: "code" } as Agent]]),
    };
    renderThread({ ...props, comments: [{ ...comment, clientStatus: "pending" }] });
    const identity = container.querySelector('[data-testid="task-chat-agent-identity"]');
    const header = container.querySelector('[data-testid="task-chat-runner-identity-row"]');
    const activity = container.querySelector('[data-testid="task-chat-current-activity-label"]');
    expect(identity?.textContent).toBe("Runner");
    expect(identity?.querySelector("svg, img")).not.toBeNull();
    expect(activity?.textContent).toBe("Thinking");

    for (const startup of [
      { ...run, runtimeMode: undefined, status: "queued", startedAt: null },
      { ...run, runtimeMode: "legacy" as const, currentStatusMessage: "run started" },
      run,
    ]) {
      renderThread({ ...props, activeRun: startup });
      expect(container.querySelector('[data-testid="task-chat-agent-identity"]')).toBe(identity);
      expect(container.querySelector('[data-testid="task-chat-runner-identity-row"]')).toBe(header);
      expect(container.querySelector('[data-testid="task-chat-current-activity-label"]')).toBe(activity);
      expect(activity?.textContent).toBe("Thinking");
      expect(container.querySelector('[data-testid="task-chat-live-run-pill"]')).toBeNull();
      expect(container.textContent).not.toContain("run started");
    }

    nativeTranscriptState.transcriptByRun.set(run.id, [
      { kind: "thinking", ts: "2026-08-25T18:00:01.000Z", text: "", lifecycle: "started", itemId: "reasoning-1" },
    ]);
    renderThread({ ...props, activeRun: run });
    expect(container.querySelector('[data-testid="task-chat-agent-identity"]')).toBe(identity);
    expect(container.querySelector('[data-testid="task-chat-runner-identity-row"]')).toBe(header);
    expect(container.textContent).toContain("Thinking");
  });

  it.each([false, true].flatMap(mobile => ["streamed", "late", "absent"].map(reply => ({ mobile, reply }))))(
    "keeps report fallbacks behind complete terminal history ($reply, mobile=$mobile)",
    ({ mobile, reply }) => {
      sidebarState.isMobile = mobile;
      const run = nativeRunningRun();
      const summary = "The report contains a longer account of the completed work.";
      const finalText = "The final reply is complete.";
      const result = {
        schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary,
        completionClaim: { objectiveSatisfied: true, remainingWork: [] },
      };
      const events: HeartbeatRunEvent[] = [];
      const append = (eventType: string, payload: Record<string, unknown>) => {
        const seq = events.length + 1;
        events.push({
          id: seq, runId: run.id, seq, eventType,
          companyId: "company", agentId: run.agentId, stream: "system", level: "info", color: null, message: null,
          createdAt: new Date(`2026-08-25T18:00:0${seq}.000Z`),
          payload: { prpEvent: {
            schema: "paperclip.prp.event.v1", schemaVersion: 1,
            runId: run.id, eventType, sourceEventId: `event-${seq}`,
            itemId: "final-reply", payload,
          } },
        });
        nativeTranscriptState.transcriptByRun.set(run.id, nativeRunEventsToTranscript(events));
      };
      const props = { comments: [], onAdd: async () => {}, issueStatus: "in_progress" };
      nativeTranscriptState.terminalHydratedRunIds = new Set();
      append("run.result.proposed", result);
      renderThread({ ...props, activeRun: run });
      const identity = container.querySelector('[data-testid="task-chat-agent-identity"]');
      expect(container.textContent).not.toContain(summary);

      if (reply === "streamed") {
        append("item.delta", { kind: "agentMessage", channel: "final", text: "The final reply" });
        renderThread({ ...props, activeRun: run });
        expect(container.textContent).toContain("The final reply");
        expect(container.textContent).not.toContain(summary);
        expect(container.querySelector('[data-testid="task-chat-agent-identity"]')).toBe(identity);
        append("item.completed", { kind: "agentMessage", channel: "final", text: finalText });
        renderThread({ ...props, activeRun: run });
        expect(container.textContent?.split(finalText)).toHaveLength(2);
      }

      const linkedRun = {
        ...run, runId: run.id, status: "succeeded", finishedAt: "2026-08-25T18:00:10.000Z",
        resultJson: { nativeResult: result },
      };
      renderThread({ ...props, linkedRuns: [linkedRun] });
      expect(container.textContent).not.toContain(summary);

      if (reply === "late") {
        append("item.completed", { kind: "agentMessage", channel: "final", text: finalText });
      }
      nativeTranscriptState.terminalHydratedRunIds = new Set([run.id]);
      renderThread({ ...props, linkedRuns: [linkedRun] });
      const displayed = reply === "absent" ? summary : finalText;
      expect(container.textContent?.split(displayed)).toHaveLength(2);
      if (reply !== "absent") expect(container.textContent).not.toContain(summary);

      renderThread({
        ...props, linkedRuns: [linkedRun], comments: [{
          id: "saved-response", companyId: "company", issueId: "issue", runId: run.id,
          authorType: "agent", authorAgentId: run.agentId, authorUserId: null,
          body: displayed, presentation: null, metadata: null,
          createdAt: new Date("2026-08-25T18:00:10.000Z"), updatedAt: new Date("2026-08-25T18:00:10.000Z"),
        }],
      });
      expect(container.textContent?.split(displayed)).toHaveLength(2);
      if (reply !== "absent") expect(container.textContent).not.toContain(summary);
    },
  );

  it.each(["summary", "provider", "empty"])("keeps empty terminal history pending before resolving its %s response", (response) => {
    const run = nativeRunningRun();
    const summary = "The accepted report is ready.";
    const finalText = "The provider's actual final reply.";
    const props = { comments: [], onAdd: async () => {}, issueStatus: "in_progress" };
    nativeTranscriptState.terminalHydratedRunIds = new Set();
    nativeTranscriptState.transcriptByRun.set(run.id, []);
    renderThread({ ...props, activeRun: run });
    const linkedRun = {
      ...run, runId: run.id, status: "succeeded", finishedAt: "2026-08-25T18:00:10.000Z",
      resultJson: response === "empty" ? null : {
        nativeResult: { schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary },
      },
    };
    renderThread({ ...props, linkedRuns: [linkedRun] });
    expect(container.textContent).not.toContain(summary);
    expect(container.textContent).not.toContain("The runner returned no user-facing response.");

    if (response === "provider") {
      nativeTranscriptState.transcriptByRun.set(run.id, [assistantEntry("2026-08-25T18:00:05.000Z", finalText, "final")]);
    }
    nativeTranscriptState.terminalHydratedRunIds = new Set([run.id]);
    renderThread({ ...props, linkedRuns: [linkedRun] });
    if (response === "empty") {
      expect(container.textContent).toContain("The runner returned no user-facing response.");
    } else {
      expect(container.textContent?.split(response === "summary" ? summary : finalText)).toHaveLength(2);
      expect(container.textContent).not.toContain("The runner returned no user-facing response.");
      if (response === "provider") expect(container.textContent).not.toContain(summary);
    }
  });

  it("keeps runner layout during admission and native transcripts scoped to native runs", () => {
    nativeTranscriptState.transcriptByRun.set("native-run", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Checking the task.", "progress"),
      assistantEntry("2026-08-25T18:00:02.000Z", "The task is ready.", "final"),
    ]);

    const run = nativeRunningRun();

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: run,
    });

    expect(
      container.querySelector('[data-testid="task-chat-runner-turn"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain("Checking the task.");
    expect(container.textContent).toContain("The task is ready.");

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: { ...run, runtimeMode: "legacy" },
    });

    expect(
      container.querySelector('[data-testid="task-chat-runner-turn"]'),
    ).not.toBeNull();
    expect(transcriptHookRuns.native.at(-1)).toEqual([]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: { ...run, adapterType: "codex_local" },
    });

    expect(
      container.querySelector('[data-testid="task-chat-runner-turn"]'),
    ).toBeNull();
  });


  it.each(["matching", "document_only", "absent", "other_revision"] as const)("reports a restore failure with %s saved-plan evidence", (evidence) => {
    if (evidence !== "absent") planState.data = planDocument();
    renderThread({
      issueId: "issue-1",
      comments: [],
      onAdd: async () => {},
      issueStatus: "blocked",
      interactions: evidence === "absent" || evidence === "document_only" ? [] : [planReviewInteraction("accepted", evidence === "matching" ? "revision-3" : "revision-2", "restore-run")],
      onRetryFailedRun: vi.fn(),
      linkedRuns: [{
        runId: "restore-run", runtimeMode: "legacy", status: "failed", errorCode: "workspace_restore_failed",
        agentId: "agent-1", agentName: "Runner", adapterType: "grok_local",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: "2026-08-25T18:00:00.000Z", finishedAt: "2026-08-25T18:00:02.000Z",
        resultJson: { workspaceRestoreFailure: "restore_unsafe_archive", workspaceRestorePath: ".claude/skills/paperclip", finalResponseRecorded: false,
          ...(evidence === "document_only" ? { savedPlanRevisionId: "revision-3" } : {}),
        },
      }],
    });
    const marker = container.querySelector('[data-testid="task-chat-collapsible-marker"]');
    expect(marker?.textContent).toContain("Workspace restore failed");
    flushSync(() => marker!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(marker?.textContent).toContain("Workspace files need recovery");
    expect(marker?.textContent).toContain("No final response was recorded");
    expect(marker?.textContent).toContain(".claude/skills/paperclip");
    expect(marker?.querySelector('a[href*="/runs/restore-run"]')).not.toBeNull();
    expect(marker?.textContent.includes("after the plan was saved")).toBe(evidence === "matching" || evidence === "document_only");
    expect(Boolean(marker?.querySelector('a[href*="document-plan"]'))).toBe(evidence === "matching" || evidence === "document_only");
    expect(marker?.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
  });

  it("uses neutral wording for an unclassified historical legacy failure", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [{
        runId: "old-run", runtimeMode: "legacy", status: "failed", errorCode: "adapter_failed",
        agentId: "agent-1", agentName: "Runner", adapterType: "grok_local",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: null, finishedAt: "2026-08-25T18:00:02.000Z",
      }],
    });
    expect(container.textContent).toContain("The run failed");
    expect(container.textContent).not.toContain("before returning an answer");
    expect(container.textContent).not.toContain("Workspace restore failed");
  });

  it("directs a missing starting branch to repair instead of offering an unchanged retry", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "blocked",
      onRetryFailedRun: vi.fn(),
      linkedRuns: [{
        runId: "missing-branch-run", runtimeMode: "legacy", status: "failed", errorCode: "configuration_incomplete",
        agentId: "agent-1", agentName: "Worker", adapterType: "claude_local",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: null, finishedAt: "2026-08-25T18:00:02.000Z",
        resultJson: { configurationIncomplete: { reason: "workspace_base_ref_unresolved", requestedRef: "main" } },
      }],
    });
    expect(container.textContent).toContain("Starting branch unavailable");
    expect(container.textContent).toContain("Repair the starting branch below before retrying.");
    expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
  });

  it.each(["legacy", "native"] as const)("keeps a %s credential denial expanded and replaces it after a successful attempt", (runtimeMode) => {
    const denied = {
      runId: "credential-run", runtimeMode, status: "failed", errorCode: "configuration_incomplete",
      agentId: "agent-1", agentName: "Codie", adapterType: runtimeMode === "native" ? "paperclip_runner" : "codex_local",
      responsibleUserId: "nicky", createdAt: "2026-08-25T18:00:00Z", startedAt: null, finishedAt: "2026-08-25T18:00:02Z",
      resultJson: { configurationIncomplete: { selectionFailure: "ai_connection_credential_not_shared", credentialAccess: { connectionName: "Dotta’s API Key" } } },
    };
    const props = { comments: [], onAdd: async () => {}, issueStatus: "blocked", currentUserId: "nicky", onRetryFailedRun: vi.fn() };
    render(<TaskChatThread {...props} linkedRuns={[denied]} />);
    const alert = container.querySelector('[data-testid="task-chat-credential-access-notice"]');
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent).toContain("Codie is configured to use Dotta’s API Key, but you don’t have access");
    expect(alert?.querySelector('a[href="/agents/agent-1/runtime"]')).not.toBeNull();
    expect(alert?.querySelector('a[href*="/runs/credential-run"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
    render(<TaskChatThread {...props} linkedRuns={[denied, { ...denied, runId: "new-run", status: "succeeded",
      resultJson: null, errorCode: null, createdAt: "2026-08-25T18:01:00Z", startedAt: "2026-08-25T18:01:00Z", finishedAt: "2026-08-25T18:01:02Z" }]} />);
    expect(container.querySelector('[data-testid="task-chat-credential-access-notice"]')).toBeNull();
  });

  it("directs a missing personal AI credential to its card without offering a premature retry", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "blocked",
      onRetryFailedRun: vi.fn(),
      interactions: [{
        ...pendingConnectionIntentInteraction, sourceRunId: "missing-ai-run",
        payload: { ...pendingConnectionIntentInteraction.payload, purpose: "ai" },
      }],
      linkedRuns: [{
        runId: "missing-ai-run", runtimeMode: "legacy", status: "failed", errorCode: "configuration_incomplete",
        agentId: "agent-1", agentName: "Chief of Staff", adapterType: "claude_local",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: null, finishedAt: "2026-08-25T18:00:02.000Z",
      }],
    });
    expect(container.textContent).toContain("AI connection needed");
    expect(container.textContent).toContain("Use the connection card below to continue.");
    expect(container.textContent).not.toContain("The selected AI account is unavailable");
    expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
  });

  it("projects the saved Plan inline at its native write_document boundary", () => {
    planState.data = planDocument({
      updatedAt: new Date("2026-08-25T18:00:02.000Z"),
    });
    nativeTranscriptState.transcriptByRun.set("native-plan", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Preparing the Plan.", "progress"),
      {
        kind: "tool_call",
        ts: "2026-08-25T18:00:02.000Z",
        name: "write_document",
        toolUseId: "write-plan",
        input: { key: "plan" },
      },
      {
        kind: "tool_result",
        ts: "2026-08-25T18:00:02.100Z",
        toolUseId: "write-plan",
        toolName: "write_document",
        content: "revision-3",
      },
      assistantEntry("2026-08-25T18:00:03.000Z", "Plan revision is ready for review.", "progress"),
    ]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: nativePlanRun("native-plan"),
    });

    const preview = container.querySelector(
      '[data-testid="task-chat-plan-preview"]',
    );
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("Preview the Plan");
    expect(
      preview?.closest('[data-testid="task-chat-runner-turn"]'),
    ).not.toBeNull();
    const rows = [
      ...container.querySelectorAll(
        '[data-testid="task-chat-turn-timeline-row"]',
      ),
    ];
    expect(rows.findIndex((row) => row.contains(preview))).toBeGreaterThan(0);
  });

  it.each([
    { name: "write_document", anchored: true },
    { name: "mcp__paperclip__write_document", anchored: false },
  ])("anchors a settled ACP Plan only at the normalized display name $name", ({ name, anchored }) => {
    const runId = "acpx-plan";
    planState.data = planDocument({ updatedAt: new Date("2026-08-25T18:00:02.000Z") });
    const events = ["started", "completed"].map((phase, index) => ({
      id: index + 1,
      companyId: "company-1",
      agentId: "agent-1",
      stream: "system",
      level: "info",
      color: null,
      message: null,
      runId,
      seq: index + 1,
      eventType: `tool.execution.${phase}`,
      createdAt: new Date(`2026-08-25T18:00:0${index + 1}.000Z`),
      payload: {
        prpEvent: {
          schema: "paperclip.prp.event.v1",
          schemaVersion: 1,
          runId,
          eventType: `tool.execution.${phase}`,
          sourceEventId: `acpx-write-${index + 1}`,
          sourceKind: "runner",
          sourceInstanceId: "runner-1",
          sourceSeq: index + 1,
          normalizedSessionId: "session-1",
          emittedAt: `2026-08-25T18:00:0${index + 1}.000Z`,
          payload: {
            schema: "paperclip.tool.execution.v1",
            executionId: "write-plan",
            transport: anchored ? "mcp" : "builtin",
            namespace: anchored ? "paperclip" : null,
            name,
            operation: "execute",
            readOnly: false,
            status: phase === "completed" ? "completed" : "running",
            output: null,
            outputBytes: 0,
            outputTruncated: false,
            outputDigest: null,
          },
        },
      },
    } satisfies HeartbeatRunEvent));
    // Exercise persisted ACP display events, without native raw arguments or
    // a fabricated semantic-tool receipt, through the actual transcript parser.
    nativeTranscriptState.transcriptByRun.set(runId, nativeRunEventsToTranscript(events));
    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "blocked",
      linkedRuns: [{
        runId,
        runtimeMode: "native",
        status: "succeeded",
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
        createdAt: "2026-08-25T18:00:00.000Z",
        startedAt: "2026-08-25T18:00:00.000Z",
        finishedAt: "2026-08-25T18:00:03.000Z",
      }],
    });
    const preview = container.querySelector('[data-testid="task-chat-plan-preview"]');
    const fallback = container.querySelector('[data-testid="task-chat-plan-preview-fallback"]');
    expect(Boolean(preview)).toBe(anchored);
    expect(Boolean(fallback)).toBe(!anchored);
    expect((preview ?? fallback)?.textContent).toContain("Preview the Plan");
    expect((preview ?? fallback)?.closest('[data-testid="task-chat-turn"][data-settled="true"]')).not.toBeNull();
  });

  it("retains a native Plan as a visible fallback while its write boundary is unavailable", () => {
    planState.data = planDocument({
      updatedAt: new Date("2026-08-25T18:00:02.000Z"),
    });
    nativeTranscriptState.transcriptByRun.set("native-plan-fallback", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Recovering the Plan transcript.", "progress"),
    ]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: nativePlanRun("native-plan-fallback"),
    });

    const fallback = container.querySelector(
      '[data-testid="task-chat-plan-preview-fallback"]',
    );
    expect(fallback?.textContent).toContain("Preview the Plan");
    expect(
      fallback?.closest('[data-testid="task-chat-runner-turn"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-plan-preview"]'),
    ).toBeNull();
  });

  it("suppresses early provider wait prose when its native interaction is pending", () => {
    nativeTranscriptState.transcriptByRun.set("native-wait", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Waiting for Plan approval.", "final"),
    ]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      interactions: [
        planReviewInteraction("pending", "revision-3", "native-wait"),
      ],
      activeRun: nativePlanRun("native-wait"),
    });

    expect(container.textContent).toContain("Review the Plan");
    expect(container.textContent).not.toContain("Waiting for Plan approval.");
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).toBeNull();
  });

  it("uses the live log when a native run has no persisted event transcript", () => {
    transcriptState.transcriptByRun.set("native-run", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Visible from the runner log fallback.", "progress"),
    ]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: nativeRunningRun(),
    });

    expect(container.textContent).toContain(
      "Visible from the runner log fallback.",
    );
  });

  it("uses a fresher live log when native event polling fails after earlier events", () => {
    nativeTranscriptState.transcriptByRun.set("native-run", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Stale native activity.", "progress"),
    ]);
    nativeTranscriptState.errorsByRun.set("native-run", {
      message: "event endpoint unavailable",
      failedAt: "2026-08-25T18:00:02.000Z",
    });
    transcriptState.transcriptByRun.set("native-run", [
      assistantEntry("2026-08-25T18:00:03.000Z", "Fresh activity from the runner log.", "progress"),
    ]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: nativeRunningRun(),
    });

    expect(container.textContent).toContain(
      "Fresh activity from the runner log.",
    );
    expect(container.textContent).not.toContain("Stale native activity.");
    expect(container.textContent).not.toContain("temporarily unavailable");
  });

  it("keeps legacy channel-less native messages readable across settlement", () => {
    nativeTranscriptState.transcriptByRun.set("native-run", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Persisted before message channels existed.", "unknown"),
    ]);

    const run = nativeRunningRun();

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: run,
    });

    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("Persisted before message channels existed.");
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).toBeNull();

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "done",
      activeRun: {
        ...run,
        status: "succeeded",
        finishedAt: "2026-08-25T18:00:02.000Z",
      },
    });

    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]')
        ?.textContent,
    ).toContain("Persisted before message channels existed.");
  });

  it("recomputes a runner turn when only the message channel changes", () => {
    const run = nativeRunningRun();
    const renderRun = () =>
      renderThread({
        comments: [],
        onAdd: async () => {},
        issueStatus: "in_progress",
        activeRun: run,
      });

    nativeTranscriptState.transcriptByRun.set("native-run", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Same text.", "progress"),
    ]);
    renderRun();
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]')
        ?.textContent,
    ).toContain("Same text.");
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).toBeNull();

    nativeTranscriptState.transcriptByRun.set("native-run", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Same text.", "final"),
    ]);
    renderRun();
    expect(
      container.querySelector('[data-testid="task-chat-phase-interstitial"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]')
        ?.textContent,
    ).toContain("Same text.");
  });

  it("recomputes a runner turn when only usage totals change", () => {
    const run = nativeRunningRun();
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
    const renderRun = () =>
      renderThread({
        comments: [],
        onAdd: async () => {},
        issueStatus: "in_progress",
        activeRun: run,
      });
    const revealUsage = () => {
      const summary = container.querySelector<HTMLButtonElement>(
        '[data-testid="task-chat-activity-phase-toggle"]',
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

  it("keeps a failed native run actionable after progress was rendered", async () => {
    const onRetryFailedRun = vi.fn();
    nativeTranscriptState.transcriptByRun.set("native-failed", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Started the provider request.", "progress"),
    ]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "blocked",
      onRetryFailedRun: onRetryFailedRun,
      linkedRuns: [
        {
          runId: "native-failed",
          runtimeMode: "native",
          status: "failed",
          errorCode: "provider_transport_failed",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z",
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:02.000Z",
        },
      ],
    });

    expect(container.textContent).toContain("Started the provider request.");
    const marker = container.querySelector(
      '[data-testid="task-chat-collapsible-marker"]',
    );
    expect(marker?.textContent).toContain("Run failed");
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-run-failed-try-again"]',
    );
    expect(retry).not.toBeNull();
    flushSync(() => retry!.click());
    await Promise.resolve();
    expect(onRetryFailedRun).toHaveBeenCalledWith("native-failed");
  });

  it.each([false, true])("keeps a later bootstrap failure actionable only after the old recovery has a successor: %s", async (continued) => {
    const onRetryFailedRun = vi.fn();
    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "blocked",
      onRetryFailedRun: onRetryFailedRun,
      linkedRuns: [
        {
          runId: "old-native", runtimeMode: "native", status: "failed", errorCode: "adapter_failed",
          agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z", startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:02.000Z",
          execution: {
            phase: continued ? "completed" : "recovery_needed", label: continued ? "Continued in another run" : "Stopped",
            cause: "native_continuation_requires_reconciliation", lastConfirmedActivityAt: null,
            retryAt: null, attempt: 1, maxAttempts: 3, recoveryOwner: null, nextAction: null,
            permittedActions: ["inspect_run"], predecessorRunId: null, successorRunId: continued ? "failed-bootstrap" : null,
          },
        },
        {
          runId: "failed-bootstrap", runtimeMode: "legacy", status: "failed", errorCode: "setup_failed",
          agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:01:00.000Z", startedAt: "2026-08-25T18:01:00.000Z",
          finishedAt: "2026-08-25T18:01:02.000Z",
        },
      ],
    });
    const retryButtons = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-testid="task-chat-run-failed-try-again"]'));
    if (!continued) {
      expect(retryButtons).toHaveLength(0);
      return;
    }
    expect(retryButtons.length).toBeGreaterThan(0);
    flushSync(() => retryButtons.at(-1)!.click());
    await Promise.resolve();
    expect(onRetryFailedRun).toHaveBeenCalledExactlyOnceWith("failed-bootstrap");
  });

  it.each([false, true])("never offers the old quarantined run as Try again after continuation: %s", continued => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      onRetryFailedRun: vi.fn(),
      linkedRuns: [{
        runId: "quarantined", runtimeMode: "native", status: "failed", errorCode: "native_session_cleanup_quarantined",
        agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: "2026-08-25T18:00:00.000Z", finishedAt: "2026-08-25T18:00:02.000Z",
        ...(continued ? { execution: { phase: "completed" as const, label: "Continued in another run", cause: "native_session_cleanup_quarantined",
          lastConfirmedActivityAt: null, retryAt: null, attempt: 2, maxAttempts: 3, recoveryOwner: null, nextAction: null,
          permittedActions: ["inspect_run" as const], predecessorRunId: null, successorRunId: "fresh-run" } } : {}),
      }],
    });
    expect(container.textContent?.includes("Run failed")).toBe(!continued);
    expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
  });

  it("explains a native provider usage limit without exposing its error code", async () => {
    const onRetryFailedRun = vi.fn();
    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "blocked",
      onRetryFailedRun: onRetryFailedRun,
      linkedRuns: [
        {
          runId: "native-usage-limit",
          runtimeMode: "native",
          status: "failed",
          errorCode: "native_provider_usage_limit",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z",
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:02.000Z",
        },
      ],
    });

    const marker = container.querySelector(
      '[data-testid="task-chat-collapsible-marker"]',
    );
    expect(marker?.textContent).toContain("Usage limit reached");
    expect(marker?.textContent).not.toContain("Run failed");
    const disclosure = marker?.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    );
    expect(disclosure).not.toBeNull();
    flushSync(() => disclosure!.click());
    const details = container.querySelector(
      '[data-testid="task-chat-collapsible-marker-details"]',
    );
    expect(details?.textContent).toContain(
      "The model provider has reached its current usage limit. Try again after the limit resets.",
    );
    expect(details?.textContent).not.toContain("native_provider_usage_limit");
    const retry = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-run-failed-try-again"]',
    );
    expect(retry).not.toBeNull();
    flushSync(() => retry!.click());
    await Promise.resolve();
    expect(onRetryFailedRun).toHaveBeenCalledWith("native-usage-limit");
  });

  it("explains a legacy run prevented from starting by a reconciliation hold", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [{
        runId: "blocked-legacy", runtimeMode: "legacy", status: "cancelled",
        errorCode: "execution_reconciliation_required", agentId: "agent-1", agentName: "Runner",
        adapterType: "claude_local", createdAt: "2026-08-25T18:00:00.000Z",
        startedAt: null, finishedAt: "2026-08-25T18:00:00.012Z",
      }],
    });
    expect(container.textContent).toContain("Waiting to resume");
    expect(container.textContent).not.toContain("No user-facing response");
    expect(container.textContent).not.toContain("Run completed");
    expect(container.querySelector(".text-destructive")).toBeNull();
  });

  it.each(["legacy", "native"] as const)("groups repeated %s pre-start holds without hiding executed work", (runtimeMode) => {
    const heldRun = (id: string, recoveryActionId: string, startedAt: string | null = null) => ({
      runId: id, runtimeMode, status: "cancelled", errorCode: "execution_reconciliation_required",
      agentId: "agent-1", adapterType: runtimeMode === "native" ? "paperclip_runner" : "claude_local",
      createdAt: "2026-09-10T18:00:00.000Z", finishedAt: "2026-09-10T18:00:01.000Z", startedAt,
      resultJson: { executionWait: { recoveryActionId } },
    });
    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [
      ...Array.from({ length: 100 }, (_, i) => heldRun(`wait-${i}`, "hold-1")),
      heldRun("ran", "hold-1", "2026-09-10T18:00:00.500Z"),
      heldRun("new-hold", "hold-2"),
      heldRun("same-new-hold", "hold-2"),
    ],
    });
    expect(container.textContent?.match(/Waiting to resume/g)).toHaveLength(2);
    expect(container.textContent).not.toContain("Couldn't start");
    expect(container.textContent).toContain(runtimeMode === "native" ? "Run cancelled" : "Stopped");
  });

  it("shows cancellation after native progress without offering a retry", () => {
    nativeTranscriptState.transcriptByRun.set("native-cancelled", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Work was in progress.", "progress"),
    ]);

    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [
        {
          runId: "native-cancelled",
          runtimeMode: "native",
          status: "cancelled",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z",
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:02.000Z",
        },
      ],
    });

    expect(container.textContent).toContain("Work was in progress.");
    expect(container.querySelector('[data-testid="task-chat-collapsible-marker"] button')?.classList).toContain("text-muted-foreground");
    expect(container.querySelector('[data-testid="task-chat-collapsible-marker"] .text-destructive')).toBeNull();
    expect(
      container.querySelector('[data-testid="task-chat-collapsible-marker"]')
        ?.textContent,
    ).toContain("Run cancelled");
    expect(
      container.querySelector('[data-testid="task-chat-run-failed-try-again"]'),
    ).toBeNull();
  });

  it.each([
    ["failed", "Run failed"],
    ["timed_out", "Run timed out"],
    ["cancelled", "Run cancelled"],
    ["interrupted", "Run interrupted"],
  ] as const)(
    "does not claim a native %s run returned no answer when its final response is visible",
    (status, expectedLabel) => {
      nativeTranscriptState.transcriptByRun.set(`native-${status}`, [
        {
          kind: "assistant",
          ts: "2026-08-25T18:00:01.000Z",
          text: `Final response before ${status}.`,
          channel: "final",
        },
      ]);

      renderThread({
        comments: [],
        onAdd: async () => {},
        linkedRuns: [
            {
              runId: `native-${status}`,
              runtimeMode: "native",
              status,
              errorCode: `native_${status}`,
              agentId: "agent-1",
              agentName: "Runner",
              adapterType: "paperclip_runner",
              createdAt: "2026-08-25T18:00:00.000Z",
              startedAt: "2026-08-25T18:00:00.000Z",
              finishedAt: "2026-08-25T18:00:02.000Z",
            },
          ],
      });

      const finalResponses = container.querySelectorAll(
        '[data-testid="task-chat-final-response"]',
      );
      expect(finalResponses).toHaveLength(1);
      expect(finalResponses[0]?.textContent).toContain(
        `Final response before ${status}.`,
      );

      const marker = container.querySelector(
        '[data-testid="task-chat-collapsible-marker"]',
      );
      expect(marker?.textContent).toContain(expectedLabel);
      const markerToggle = marker?.querySelector<HTMLButtonElement>(
        'button[aria-expanded="false"]',
      );
      expect(markerToggle).not.toBeNull();
      flushSync(() => markerToggle!.click());

      const detail = container.querySelector(
        '[data-testid="task-chat-collapsible-marker-details"]',
      );
      expect(detail?.textContent).toContain("after returning a final response");
      expect(detail?.textContent).not.toContain("before returning an answer");
      expect(container.textContent).not.toContain(
        "The runner returned no user-facing response.",
      );
    },
  );

  it("shows an actionable approval-required reason for a stopped native run", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [{
        runId: "approval-required", runtimeMode: "native", status: "failed",
        errorCode: "native_provider_approval_required",
        agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner",
        startedAt: "2026-09-14T15:00:00.000Z", createdAt: "2026-09-14T15:00:00.000Z",
        finishedAt: "2026-09-14T15:00:02.000Z",
      }],
    });
    const marker = container.querySelector('[data-testid="task-chat-collapsible-marker"]');
    expect(marker?.textContent).toContain("Approval required");
    flushSync(() => marker!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
    expect(container.textContent).toContain("Review the operation and update the agent's permission setting before retrying");
    expect(container.textContent).not.toContain("The runner stopped");
  });

  it.each([
    "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
    "The selected model is not supported by the current ChatGPT connection. Choose a supported model or a compatible AI connection.",
  ])("promotes a rejected model above the runner's generated failure response: %s", (error) => {
    nativeTranscriptState.transcriptByRun.set("model-rejected", [{
      kind: "run_result", ts: "2026-08-25T18:00:01.000Z",
      summary: "The Codex run failed before it completed.",
      disposition: "needs_review", objectiveSatisfied: false, verification: [],
      remainingWork: [], blocker: null, artifacts: [],
    }]);
    renderThread({
      comments: [],
      onAdd: async () => {},
      interruption: { intentId: null, responsibility: "user", state: "waiting_for_user", nextRetryAt: null,
        canRetry: false, userAction: "choose_model", sourceRunIds: ["model-rejected"], observedRunId: "model-rejected" },
      linkedRuns: [{
        runId: "model-rejected", runtimeMode: "native", status: "failed",
        errorCode: "native_provider_model_rejected",
        error,
        agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner",
        createdAt: "2026-08-25T18:00:00.000Z", startedAt: "2026-08-25T18:00:00.000Z",
        finishedAt: "2026-08-25T18:00:02.000Z",
      }],
    });
    const marker = container.querySelector('[data-testid="task-chat-collapsible-marker"]');
    expect(marker?.textContent).toContain("Model unavailable");
    flushSync(() => marker!.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
    expect(container.textContent).toContain(error);
    expect(container.textContent).toContain("clear the task's model override, then retry");
    expect(container.textContent).not.toContain("after returning a final response");
  });

  it("keeps workspace contention out of the conversation's cancellation markers", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [{
        runId: "workspace-wait", runtimeMode: "native", status: "cancelled", errorCode: "workspace_busy",
        agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner", startedAt: null,
        createdAt: "2026-09-12T18:00:00.000Z", finishedAt: "2026-09-12T18:00:01.000Z",
      }],
    });
    expect(container.textContent).not.toContain("Run cancelled");
    expect(container.textContent).not.toContain("Run failed");
    expect(container.textContent).not.toContain("before returning an answer");
  });

  it("does not render an empty response notice for a conversation reset", () => {
    renderThread({
      comments: [],
      onAdd: async () => {},
      linkedRuns: [{
        runId: "chat-reset", status: "succeeded", startedAt: null, resultJson: { conversationReset: true },
        agentId: "agent-1", agentName: "Claude", adapterType: "claude_local",
        createdAt: "2026-09-11T18:00:00.000Z", finishedAt: "2026-09-11T18:00:01.000Z",
      }],
    });
    expect(container.textContent).not.toContain("The runner returned no user-facing response.");
    expect(container.textContent).not.toContain("Run completed");
  });

  it.each([
    ["legacy", "issue_not_in_progress"],
    ["native", "issue_not_in_progress"],
    ["legacy", "issue_terminal_status"],
    ["native", "issue_terminal_status"],
  ] as const)(
    "hides a redundant cancelled continuation (%s, %s)",
    (runtimeMode, errorCode) => {
      renderThread({
        comments: [],
        onAdd: async () => {},
        linkedRuns: [
          {
            runId: "connection-continuation-skipped",
            runtimeMode,
            status: "cancelled",
            errorCode,
            startedAt: null,
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-09-07T18:00:00.000Z",
            finishedAt: "2026-09-07T18:00:01.000Z",
          },
        ],
      });
      expect(container.textContent).not.toContain(
        "The runner returned no user-facing response.",
      );
      expect(container.textContent).not.toContain("Run completed");
      expect(container.textContent).not.toContain("Couldn't start");
      expect(container.textContent).not.toContain("Run cancelled");
      expect(container.textContent).not.toContain("before returning an answer");
    },
  );

  it.each(["legacy", "native"] as const)(
    "keeps a cancellation visible when the %s run had already started",
    (runtimeMode) => {
      renderThread({
        comments: [],
        onAdd: async () => {},
        linkedRuns: [
          {
            runId: "started-cancellation",
            runtimeMode,
            status: "cancelled",
            errorCode: "issue_terminal_status",
            agentId: "agent-1",
            agentName: "Runner",
            adapterType: "paperclip_runner",
            createdAt: "2026-09-07T18:00:00.000Z",
            startedAt: "2026-09-07T18:00:00.500Z",
            finishedAt: "2026-09-07T18:00:01.000Z",
          },
        ],
      });
      expect(container.textContent).toContain(
        runtimeMode === "native" ? "Run cancelled" : "Stopped",
      );
    },
  );

  it("does not treat a progress comment as the final response of a failed native run", () => {
    nativeTranscriptState.transcriptByRun.set("native-progress-failed", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Still working through the provider request.", "progress"),
    ]);

    renderThread({
      comments: [
        {
          id: "progress-comment",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "Progress checkpoint only.",
          presentation: null,
          metadata: null,
          runId: "native-progress-failed",
          createdAt: new Date("2026-08-25T18:00:01.500Z"),
          updatedAt: new Date("2026-08-25T18:00:01.500Z"),
        },
      ],
      onAdd: async () => {},
      linkedRuns: [
        {
          runId: "native-progress-failed",
          runtimeMode: "native",
          status: "failed",
          errorCode: "provider_transport_failed",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z",
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:02.000Z",
          resultJson: {
            presentationDecision: {
              schema: "paperclip.run_presentation_decision.v1",
              chosenSource: "none",
              commentId: null,
            },
          },
        },
      ],
    });

    const marker = container.querySelector(
      '[data-testid="task-chat-collapsible-marker"]',
    );
    const markerToggle = marker?.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    );
    expect(markerToggle).not.toBeNull();
    flushSync(() => markerToggle!.click());
    expect(
      container.querySelector(
        '[data-testid="task-chat-collapsible-marker-details"]',
      )?.textContent,
    ).toContain("The runner stopped (provider_transport_failed).");
    expect(
      container.querySelector('[data-testid="task-chat-final-response"]'),
    ).toBeNull();
  });

  it("does not repeat progress when the persisted completion comment owns the same text", () => {
    const repeated = "BASELINE-DONE";
    nativeTranscriptState.transcriptByRun.set("native-repeated-final", [
      assistantEntry("2026-08-25T18:00:01.000Z", repeated, "progress"),
      assistantEntry("2026-08-25T18:00:02.000Z", repeated, "final"),
    ]);

    renderThread({
      comments: [
        {
          id: "native-repeated-final-comment",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: repeated,
          presentation: null,
          metadata: null,
          runId: "native-repeated-final",
          createdAt: new Date("2026-08-25T18:00:03.000Z"),
          updatedAt: new Date("2026-08-25T18:00:03.000Z"),
        },
      ],
      onAdd: async () => {},
      linkedRuns: [
        {
          runId: "native-repeated-final",
          runtimeMode: "native",
          status: "succeeded",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z",
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:03.000Z",
          resultJson: {
            presentationDecision: {
              schema: "paperclip.run_presentation_decision.v1",
              chosenSource: "final_agent_message",
              commentId: "native-repeated-final-comment",
            },
          },
        },
      ],
    });

    expect(container.textContent?.split(repeated)).toHaveLength(2);
    expect(
      Array.from(
        container.querySelectorAll(
          '[data-testid="task-chat-phase-interstitial"]',
        ),
      ).some((element) => element.textContent?.includes(repeated)),
    ).toBe(false);
    expect(
      container.querySelector('[data-testid="task-chat-agent-bubble"]')
        ?.textContent,
    ).toContain(repeated);
  });

  it("removes only the final repeated progress across steering segments", () => {
    const repeated = "SAME-BEFORE-AND-AFTER";
    nativeTranscriptState.transcriptByRun.set("native-steered-repetition", [
      assistantEntry("2026-08-25T18:00:01.000Z", repeated, "progress"),
      assistantEntry("2026-08-25T18:00:03.000Z", repeated, "progress"),
      assistantEntry("2026-08-25T18:00:04.000Z", repeated, "final"),
    ]);

    renderThread({
      comments: [
        {
          id: "steering-comment",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "user",
          authorAgentId: null,
          authorUserId: "user-1",
          body: "Steer this run.",
          presentation: null,
          metadata: null,
          runId: null,
          followUpRequested: true,
          consumedByRunId: "native-steered-repetition",
          steeredIntoRunId: "native-steered-repetition",
          conversationAnchorAt: new Date("2026-08-25T18:00:02.000Z"),
          createdAt: new Date("2026-08-25T17:59:32.000Z"),
          updatedAt: new Date("2026-08-25T18:00:02.000Z"),
        },
        {
          id: "native-steered-repetition-final",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: repeated,
          presentation: null,
          metadata: null,
          runId: "native-steered-repetition",
          createdAt: new Date("2026-08-25T18:00:05.000Z"),
          updatedAt: new Date("2026-08-25T18:00:05.000Z"),
        },
      ],
      onAdd: async () => {},
      linkedRuns: [
        {
          runId: "native-steered-repetition",
          runtimeMode: "native",
          status: "succeeded",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z",
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:05.000Z",
          resultJson: {
            presentationDecision: {
              schema: "paperclip.run_presentation_decision.v1",
              chosenSource: "final_agent_message",
              commentId: "native-steered-repetition-final",
            },
          },
        },
      ],
    });

    const matchingPhases = Array.from(
      container.querySelectorAll(
        '[data-testid="task-chat-phase-interstitial"]',
      ),
    ).filter((element) => element.textContent?.includes(repeated));
    expect(matchingPhases).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="task-chat-agent-bubble"]')
        ?.textContent,
    ).toContain(repeated);
    expect(container.textContent).toContain(
      new Date("2026-08-25T17:59:32.000Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
    const turnHeaders = Array.from(
      container.querySelectorAll('[data-testid="task-chat-turn-summary"]'),
    );
    expect(turnHeaders).toHaveLength(2);
    expect(turnHeaders[0]?.textContent).not.toContain(
      "Continued after steering",
    );
    expect(turnHeaders[1]?.textContent).toContain(
      "Continued after steering · Worked for",
    );
  });

  it("keeps a pending native permission answerable after same-turn steering", async () => {
    const runId = "native-pending-steered";
    nativeTranscriptState.transcriptByRun.set(runId, [
      { kind: "runtime_request", ts: "2026-08-25T18:00:01.000Z", requestId: "permission-1",
        requestKind: "permission_approval", turnId: "provider-turn-1", requestType: "permission", status: "pending",
        prompt: "Pi write", choices: [{ key: "decline", label: "Deny" }], fields: [] },
      assistantEntry("2026-08-25T18:00:03.000Z", "Steering acknowledged.", "progress"),
    ]);
    const resolve = vi.spyOn(heartbeatsApi, "resolveRuntimeRequest").mockResolvedValue({} as never);
    renderThread({
      comments: [{
        id: "pending-steering-comment", companyId: "company-1", issueId: "issue-1", authorType: "user",
        authorAgentId: null, authorUserId: "user-1", body: "Change course.", presentation: null, metadata: null,
        runId: null, consumedByRunId: runId, steeredIntoRunId: runId,
        conversationAnchorAt: new Date("2026-08-25T18:00:02.000Z"),
        createdAt: new Date("2026-08-25T18:00:02.000Z"), updatedAt: new Date("2026-08-25T18:00:02.000Z"),
      }],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
        id: runId, runtimeMode: "native", status: "running", invocationSource: "issue", triggerDetail: null,
        startedAt: "2026-08-25T18:00:00.000Z", finishedAt: null, createdAt: "2026-08-25T18:00:00.000Z",
        agentId: "agent-1", agentName: "Runner", adapterType: "paperclip_runner",
      },
    });
    const deny = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).filter(button => button.textContent === "Deny");
    expect(deny).toHaveLength(1);
    expect(deny[0].disabled).toBe(false);
    expect(container.textContent).not.toContain("Cancelled");
    await act(async () => deny[0].click());
    expect(resolve).toHaveBeenCalledWith({ runId, requestId: "permission-1", turnId: "provider-turn-1",
      requestKind: "permission_approval", resolution: { action: "decline" } });
  });

  it("labels the live tail as a continuation after the steering bubble", () => {
    nativeTranscriptState.transcriptByRun.set("native-live-steered", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Work before steering.", "progress"),
      assistantEntry("2026-08-25T18:00:03.000Z", "Work after steering.", "progress"),
    ]);

    renderThread({
      comments: [
        {
          id: "live-steering-comment",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "user",
          authorAgentId: null,
          authorUserId: "user-1",
          body: "Change course now.",
          presentation: null,
          metadata: null,
          runId: null,
          consumedByRunId: "native-live-steered",
          steeredIntoRunId: "native-live-steered",
          conversationAnchorAt: new Date("2026-08-25T18:00:02.000Z"),
          createdAt: new Date("2026-08-25T17:59:32.000Z"),
          updatedAt: new Date("2026-08-25T18:00:02.000Z"),
        },
      ],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
        id: "native-live-steered",
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
      },
    });

    expect(
      container.querySelector('[data-testid="task-chat-turn-summary"]')
        ?.textContent,
    ).not.toContain("Continued after steering");
    expect(
      container.querySelector('[data-testid="task-chat-turn-status-header"]')
        ?.textContent,
    ).toContain("Continued after steering · Working for");
    expect(container.textContent).toContain(
      new Date("2026-08-25T17:59:32.000Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    );
  });

  it.each([
    "missing_result_metadata",
    "yielded_result_metadata",
    "steered_missing_result_metadata",
    "persisted_response_comment",
    "pending_attention",
    "live",
    "failed",
    "proposed",
    "question",
    "approval",
  ])("renders only an authorized terminal response-wake answer: %s", (mode) => {
    const runId = "native-checklist-response";
    const summary =
      "**Before release**\n- Test and rehearse rollback.\n\n**During release**\n- Deploy incrementally and watch errors.\n\n**After release**\n- Verify workflows and record follow-ups.";
    const result = {
      schema: "paperclip.run_result.v1",
      reportedWorkDisposition: "yielded",
      summary,
      completionClaim: { objectiveSatisfied: true, remainingWork: [] },
      continuation: {
        kind: "response_wake",
        idempotencyKey: "next-chat-input",
      },
      attentionRequests:
        mode === "question" || mode === "approval"
          ? [
              {
                kind:
                  mode === "question"
                    ? "ask_user_questions"
                    : "request_confirmation",
              },
            ]
          : [],
      evidence: [],
      verification: [],
      artifacts: [],
    };
    const event = (
      seq: number,
      eventType: string,
      payload: Record<string, unknown>,
    ) =>
      ({
        id: seq,
        companyId: "company-1",
        agentId: "agent-1",
        stream: "system",
        level: "info",
        color: null,
        message: null,
        runId,
        seq,
        eventType,
        createdAt: new Date("2026-08-25T18:00:00Z"),
        payload: {
          prpEvent: {
            schema: "paperclip.prp.event.v1",
            schemaVersion: 1,
            runId,
            eventType,
            sourceEventId: `checklist-${seq}`,
            sourceKind:
              eventType === "run.result.accepted" ||
              eventType === "run.terminal"
                ? "control_plane"
                : "runner",
            sourceInstanceId: "runner-1",
            sourceSeq: seq,
            normalizedSessionId: "session-1",
            emittedAt: `2026-08-25T18:00:0${seq}Z`,
            payload,
          },
        },
      }) satisfies HeartbeatRunEvent;
    nativeTranscriptState.transcriptByRun.set(
      runId,
      nativeRunEventsToTranscript([
        event(1, "item.completed", {
          kind: "agentMessage",
          channel: "progress",
          item: {
            id: "preamble",
            type: "agentMessage",
            channel: "progress",
            text: "I’m providing the requested checklist and leaving the task open.",
          },
        }),
        event(2, "run.result.proposed", result),
        ...(mode === "proposed"
          ? []
          : [event(3, "run.result.accepted", { result })]),
        event(4, "run.terminal", {
          schema: "paperclip.prp.terminal.v1",
          turnTerminalState: "completed",
          runTerminalState: "succeeded",
          reportedWorkDisposition: "yielded",
        }),
      ]),
    );
    renderThread({
      comments: mode === "steered_missing_result_metadata"
      ? [
          {
            id: "response-wake-steering",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "user",
            authorAgentId: null,
            authorUserId: "user-1",
            body: "Keep the task open for follow-up.",
            presentation: null,
            metadata: null,
            runId: null,
            followUpRequested: true,
            consumedByRunId: runId,
            steeredIntoRunId: runId,
            conversationAnchorAt: new Date("2026-08-25T18:00:03.500Z"),
            createdAt: new Date("2026-08-25T18:00:03.000Z"),
            updatedAt: new Date("2026-08-25T18:00:03.500Z"),
          },
        ]
      : mode === "persisted_response_comment"
        ? [
            {
              id: "private-board-response",
              companyId: "company-1",
              issueId: "issue-1",
              authorType: "agent",
              authorAgentId: "agent-1",
              authorUserId: null,
              body: summary,
              presentation: null,
              metadata: null,
              createdByRunId: runId,
              runId,
              createdAt: new Date("2026-08-25T18:00:29.000Z"),
              updatedAt: new Date("2026-08-25T18:00:29.000Z"),
            },
          ]
        : [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      interactions: mode === "pending_attention"
      ? [planReviewInteraction("pending", "revision-3", runId)]
      : [],
      activeRun: mode === "live"
      ? {
          id: runId,
          runtimeMode: "native",
          status: "running",
          invocationSource: "issue",
          triggerDetail: null,
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00Z",
          startedAt: "2026-08-25T18:00:00Z",
          finishedAt: null,
        }
      : undefined,
      linkedRuns: [
        {
          runId,
          runtimeMode: "native",
          status:
            mode === "live"
              ? "running"
              : mode === "failed"
                ? "failed"
                : "succeeded",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00Z",
          startedAt: "2026-08-25T18:00:00Z",
          finishedAt: mode === "live" ? null : "2026-08-25T18:00:30Z",
          resultJson: mode.endsWith("missing_result_metadata")
            ? { recoveredExecutionFailure: { errorCode: "adapter_failed" } }
            : {
                nativeResult: result,
                ...(mode === "persisted_response_comment"
                  ? {
                      presentationDecision: {
                        schema: "paperclip.run_presentation_decision.v1",
                        chosenSource: "existing_issue_comment",
                        commentId: "private-board-response",
                      },
                    }
                  : {}),
              },
        },
      ],
    });
    const responses = container.querySelectorAll(
      '[data-testid="task-chat-final-response"]',
    );
    if (mode === "persisted_response_comment") {
      expect(responses).toHaveLength(0);
      expect(container.textContent?.split("Before release")).toHaveLength(2);
      expect(
        container.querySelector('[data-testid="task-chat-agent-bubble"]')
          ?.textContent,
      ).toContain("After release");
      return;
    }
    if (
      mode !== "missing_result_metadata" &&
      mode !== "yielded_result_metadata" &&
      mode !== "steered_missing_result_metadata"
    ) {
      expect(responses).toHaveLength(0);
      return;
    }
    expect(responses).toHaveLength(1);
    expect(responses[0]?.textContent).toContain("Before release");
    expect(responses[0]?.textContent).toContain("After release");
    expect(responses[0]?.textContent).not.toContain("I’m providing");
    expect(container.textContent).not.toContain(
      "The runner returned no user-facing response.",
    );
  });

  it("keeps a yielded question turn out of the final-response slot", () => {
    nativeTranscriptState.transcriptByRun.set("native-question", [
      assistantEntry("2026-08-25T18:00:01.000Z", "Preparing the verification question.", "progress"),
      assistantEntry("2026-08-25T18:00:02.000Z", "Waiting for Choose the verification word.", "final"),
    ]);
    nativeTranscriptState.transcriptByRun.set("native-continuation", [
      assistantEntry("2026-08-25T18:01:01.000Z", "Cobalt was selected and the task is complete.", "final"),
    ]);

    renderThread({
      comments: [
        {
          id: "native-question-placeholder",
          companyId: "company-1",
          issueId: "issue-1",
          authorType: "agent",
          authorAgentId: "agent-1",
          authorUserId: null,
          body: "Run completed. Agent did not post a summary comment this run (transcript withheld — see run log).",
          presentation: null,
          metadata: null,
          runId: "native-question",
          createdAt: new Date("2026-08-25T18:00:03.000Z"),
          updatedAt: new Date("2026-08-25T18:00:03.000Z"),
        },
      ],
      onAdd: async () => {},
      linkedRuns: [
        {
          runId: "native-question",
          runtimeMode: "native",
          status: "succeeded",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:00:00.000Z",
          startedAt: "2026-08-25T18:00:00.000Z",
          finishedAt: "2026-08-25T18:00:03.000Z",
          resultJson: {
            nativeResult: {
              schema: "paperclip.run_result.v1",
              reportedWorkDisposition: "yielded",
              summary: "Waiting for Choose the verification word.",
            },
            presentationDecision: {
              schema: "paperclip.run_presentation_decision.v1",
              chosenSource: "none",
              commentId: null,
            },
          },
        },
        {
          runId: "native-continuation",
          runtimeMode: "native",
          status: "succeeded",
          agentId: "agent-1",
          agentName: "Runner",
          adapterType: "paperclip_runner",
          createdAt: "2026-08-25T18:01:00.000Z",
          startedAt: "2026-08-25T18:01:00.000Z",
          finishedAt: "2026-08-25T18:01:02.000Z",
          resultJson: {
            nativeResult: {
              schema: "paperclip.run_result.v1",
              reportedWorkDisposition: "done",
              summary: "Cobalt was selected and the task is complete.",
            },
            presentationDecision: {
              schema: "paperclip.run_presentation_decision.v1",
              chosenSource: "none",
              commentId: null,
            },
          },
        },
      ],
    });

    const finalResponses = container.querySelectorAll(
      '[data-testid="task-chat-final-response"]',
    );
    expect(finalResponses).toHaveLength(1);
    expect(finalResponses[0]?.textContent).toContain(
      "Cobalt was selected and the task is complete.",
    );
    expect(container.textContent).toContain(
      "Preparing the verification question.",
    );
    expect(container.textContent).not.toContain(
      "Waiting for Choose the verification word.",
    );
    expect(container.textContent).not.toContain("transcript withheld");
  });

  it.each(["failed", "timed_out", "cancelled"] as const)(
    "keeps an empty legacy %s actionable without turning Stop into Retry",
    async (status) => {
      const onRetryFailedRun = vi.fn();
      renderThread({
        comments: [],
        onAdd: async () => {},
        issueStatus: "blocked",
        onRetryFailedRun: onRetryFailedRun,
        linkedRuns: [
          {
            runId: "legacy-failed",
            runtimeMode: "legacy",
            status,
            errorCode: "legacy_process_exited",
            agentId: "agent-1",
            agentName: "Direct Codex",
            adapterType: "codex_local",
            createdAt: "2026-08-25T18:00:00.000Z",
            startedAt: "2026-08-25T18:00:00.000Z",
            finishedAt: "2026-08-25T18:00:02.000Z",
          },
        ],
      });

      expect(container.textContent).toContain(status === "cancelled" ? "Stopped" : "Run failed");
      if (status !== "cancelled") {
        expect(container.textContent).toContain("You can retry this message now.");
      }
      expect(
        container.querySelector('[data-testid="task-chat-collapsible-marker"]'),
      ).toBeNull();
      const retry = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-run-failed-try-again"]');
      if (status === "cancelled") {
        expect(retry).toBeNull();
      } else {
        expect(retry).not.toBeNull();
        flushSync(() => retry!.click());
        await Promise.resolve();
        expect(onRetryFailedRun).toHaveBeenCalledExactlyOnceWith("legacy-failed");
      }
      expect(
        container.querySelector('[data-testid="task-chat-runner-turn"]'),
      ).toBeNull();
    },
  );

  it.each(["failed", "timed_out"] as const)(
    "retries the latest legacy %s attempt even when it has a transcript and final comment",
    async (status) => {
      const onRetryFailedRun = vi.fn();
      transcriptState.transcriptByRun.set("latest-attempt", [{
        kind: "assistant",
        ts: "2026-08-25T18:01:01.000Z",
        text: "Starting the requested revision.",
      }]);
      const run = {
        runtimeMode: "legacy" as const,
        adapterType: "claude_local",
        agentId: "agent-1",
        agentName: "Direct agent",
        startedAt: null,
      };
      renderThread({
        comments: [{
          id: "failure-comment",
          companyId: "company-1",
          issueId: "issue-1",
          authorAgentId: "agent-1",
          authorUserId: null,
          authorType: "agent",
          presentation: null,
          metadata: null,
          body: "The startup handshake timed out.",
          runId: "latest-attempt",
          createdAt: new Date("2026-08-25T18:01:02.000Z"),
          updatedAt: new Date("2026-08-25T18:01:02.000Z"),
        }],
        onAdd: async () => {},
        issueStatus: "todo",
        onRetryFailedRun: onRetryFailedRun,
        linkedRuns: [
          { ...run, runId: "original-failure", status: "failed",
            createdAt: "2026-08-25T18:00:00.000Z", startedAt: "2026-08-25T18:00:00.000Z",
            finishedAt: "2026-08-25T18:00:02.000Z" },
          { ...run, runId: "latest-attempt", status, errorCode: "acpx_handshake_timeout",
            createdAt: "2026-08-25T18:01:00.000Z", startedAt: "2026-08-25T18:01:00.000Z",
            finishedAt: "2026-08-25T18:01:02.000Z",
            resultJson: { presentationDecision: { commentId: "failure-comment" } } },
          { ...run, runId: "cancelled-automatic-retry", status: "cancelled",
            errorCode: "execution_reconciliation_required",
            createdAt: "2026-08-25T18:02:00.000Z", finishedAt: "2026-08-25T18:02:02.000Z" },
        ],
      });

      expect(container.textContent).toContain("The startup handshake timed out.");
      const buttons = container.querySelectorAll<HTMLButtonElement>('[data-testid="task-chat-run-failed-try-again"]');
      expect(buttons).toHaveLength(1);
      flushSync(() => buttons[0]!.click());
      await Promise.resolve();
      expect(onRetryFailedRun).toHaveBeenCalledExactlyOnceWith("latest-attempt");
    },
  );

  it.each(["Muse", "Dot"].flatMap(
    (provider) => [false, true].map((hasTranscript) => ({ provider, hasTranscript })),
  ))(
    "hides a previous agent's Retry while waiting for $provider acceptance (transcript: $hasTranscript)",
    async ({ provider, hasTranscript }) => {
      const onRetryFailedRun = vi.fn();
      if (hasTranscript) transcriptState.transcriptByRun.set("previous-failure", [{
        kind: "assistant", ts: "2026-08-25T18:00:01.000Z", text: "Starting the task.",
      }]);
      const failedRun = {
        runId: "previous-failure",
        runtimeMode: "legacy" as const,
        status: "failed",
        errorCode: "legacy_process_exited",
        agentId: "previous-agent",
        agentName: "Direct Codex",
        adapterType: "codex_local",
        createdAt: "2026-08-25T18:00:00.000Z",
        startedAt: "2026-08-25T18:00:00.000Z",
        finishedAt: "2026-08-25T18:00:02.000Z",
      };
      const waitingRun = {
        runId: "external-offer",
        runtimeMode: "native" as const,
        status: "queued",
        agentId: "external-agent",
        agentName: provider,
        adapterType: "paperclip_runner",
        createdAt: "2026-08-25T18:01:00.000Z",
        startedAt: null,
        finishedAt: null,
        execution: {
          phase: "waiting_for_provider" as const,
          label: `Waiting for ${provider}`,
          cause: null,
          lastConfirmedActivityAt: null,
          retryAt: null,
          attempt: 1,
          maxAttempts: 3,
          recoveryOwner: null,
          nextAction: null,
          permittedActions: [],
          predecessorRunId: null,
          successorRunId: null,
        },
      };
      const renderRun = (waiting: boolean) => render(
        <TaskChatThread
          comments={[]}
          onAdd={async () => {}}
          issueStatus="in_progress"
          onRetryFailedRun={onRetryFailedRun}
          linkedRuns={waiting ? [failedRun, waitingRun] : [failedRun]}
        />,
      );
      // The linked projection must guard Retry before active/live-run polling arrives.
      renderRun(true);
      expect(container.textContent).toContain("Your message is preserved.");
      expect(container.textContent).not.toContain("You can retry this message now.");
      expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
      expect(onRetryFailedRun).not.toHaveBeenCalled();
      renderRun(false);
      expect(container.textContent).toContain("You can retry this message now.");
      const retry = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-run-failed-try-again"]');
      expect(retry).not.toBeNull();
      flushSync(() => retry!.click());
      await Promise.resolve();
      expect(onRetryFailedRun).toHaveBeenCalledExactlyOnceWith("previous-failure");
    },
  );

  it.each(["active execution", "pending decision", "recovery hold"].flatMap(
    (gate) => [false, true].map((hasTranscript) => ({ gate, hasTranscript })),
  ))(
    "does not promise legacy Retry during $gate (transcript: $hasTranscript) and restores it when the gate clears",
    ({ gate, hasTranscript }) => {
      const onRetryFailedRun = vi.fn();
      if (hasTranscript) transcriptState.transcriptByRun.set("legacy-failed", [{
        kind: "assistant", ts: "2026-08-25T18:00:01.000Z", text: "Starting the task.",
      }]);
      const failedRun = {
        runId: "legacy-failed",
        runtimeMode: "legacy" as const,
        status: "failed",
        errorCode: "legacy_process_exited",
        agentId: "agent-1",
        agentName: "Direct Codex",
        adapterType: "codex_local",
        createdAt: "2026-08-25T18:00:00.000Z",
        startedAt: "2026-08-25T18:00:00.000Z",
        finishedAt: "2026-08-25T18:00:02.000Z",
      };
      const gateProps: Partial<ComponentProps<typeof TaskChatThread>> =
        gate === "pending decision"
          ? { interactions: [planReviewInteraction()] }
          : {
              linkedRuns: [{
                ...failedRun,
                execution: {
                  phase: gate === "active execution" ? "working" : "recovery_needed",
                  label: "Waiting",
                  cause: null,
                  lastConfirmedActivityAt: null,
                  retryAt: null,
                  attempt: 1,
                  maxAttempts: 3,
                  recoveryOwner: null,
                  nextAction: null,
                  permittedActions: [],
                  predecessorRunId: null,
                  successorRunId: null,
                },
              }],
            };
      const renderRun = (held: boolean) => render(
        <TaskChatThread
          comments={[]}
          onAdd={async () => {}}
          issueStatus="blocked"
          onRetryFailedRun={onRetryFailedRun}
          linkedRuns={[failedRun]}
          {...(held ? gateProps : {})}
        />,
      );
      renderRun(true);
      expect(container.textContent).toContain("Your message is preserved.");
      expect(container.textContent).not.toContain("You can retry this message now.");
      expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).toBeNull();
      renderRun(false);
      expect(container.textContent).toContain("You can retry this message now.");
      expect(container.querySelector('[data-testid="task-chat-run-failed-try-again"]')).not.toBeNull();
    },
  );

  it.each([
    ...["claude_local", "codex_local", "cursor", "gemini_local", "opencode_local",
      "pi_local", "grok_local", "kimi_local", "hermes_local"].flatMap((adapterType) =>
      ["failed", "timed_out"].map((status) => ({ adapterType, status, runtimeMode: "legacy" as const,
        cause: "legacy_execution_requires_reconciliation", canRetry: true }))),
    { adapterType: "paperclip_runner", status: "failed", runtimeMode: "native" as const,
      cause: "legacy_execution_requires_reconciliation", canRetry: false },
    { adapterType: "process", status: "failed", runtimeMode: "legacy" as const,
      cause: "legacy_execution_requires_reconciliation", canRetry: false },
    { adapterType: "claude_local", status: "failed", runtimeMode: "legacy" as const,
      cause: "uncertain_provider_action", canRetry: false },
    { adapterType: "claude_local", status: "cancelled", runtimeMode: "legacy" as const,
      cause: "legacy_execution_requires_reconciliation", canRetry: false },
  ].flatMap(testCase => [false, true].map(withRecoveryNotice => ({ ...testCase, withRecoveryNotice }))))("offers only explicit conversation retries: $runtimeMode/$adapterType/$status/$cause (recovery notice=$withRecoveryNotice)", async (testCase) => {
    const retry = vi.fn();
    const recoveryRetry = vi.fn();
    renderThread({
      comments: testCase.withRecoveryNotice ? [{
        id: "recovery-after-stop", companyId: "company", issueId: "issue", metadata: null,
        authorType: "system", authorAgentId: null, authorUserId: null,
        body: "Paperclip retried continuation, but it still has no live execution path.",
        presentation: { kind: "system_notice", title: "No live execution path", tone: "danger", detailsDefaultOpen: false },
        createdAt: new Date("2026-08-25T18:00:03.000Z"), updatedAt: new Date("2026-08-25T18:00:03.000Z"),
      }] : [],
      onAdd: async () => {},
      issueStatus: "blocked",
      onRetryFailedRun: retry,
      onTryAgainNoLiveExecutionPath: recoveryRetry,
      linkedRuns: [{
        runId: "stopped-run",
        runtimeMode: testCase.runtimeMode,
        adapterType: testCase.adapterType,
        status: testCase.status,
        agentId: "agent-1",
        agentName: "Stopped agent",
        createdAt: "2026-08-25T18:00:00.000Z",
        startedAt: "2026-08-25T18:00:00.000Z",
        finishedAt: "2026-08-25T18:00:02.000Z",
        execution: {
          phase: "recovery_needed", label: "Stopped", cause: testCase.cause,
          lastConfirmedActivityAt: null, retryAt: null, attempt: 1, maxAttempts: 3,
          recoveryOwner: null, nextAction: null, permittedActions: [],
          predecessorRunId: null, successorRunId: null,
        },
      }],
    });
    const button = container.querySelector<HTMLButtonElement>(testCase.withRecoveryNotice
      ? '[data-testid="task-chat-no-live-path-try-again"]'
      : '[data-testid="task-chat-run-failed-try-again"]');
    expect(Boolean(button)).toBe(testCase.canRetry);
    if (testCase.withRecoveryNotice) {
      expect(container.textContent).toContain("No live execution path");
      expect(container.textContent).not.toContain("Run failed");
    } else if (testCase.canRetry) expect(container.textContent).toContain("You can retry this message now.");
    else expect(container.textContent).not.toContain("You can retry this message now.");
    if (button) {
      flushSync(() => button.click());
      await Promise.resolve();
      expect(retry).toHaveBeenCalledExactlyOnceWith("stopped-run");
    }
    expect(recoveryRetry).not.toHaveBeenCalled();
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

      renderThread({
        comments: [],
        onAdd: async () => {},
        issueStatus: "in_progress",
        activeRun: {
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
        },
      });

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

      renderThread({
        comments: [],
        onAdd: async () => {},
        linkedRuns: [
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
        ],
      });

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
      renderThread({
        comments: [],
        onAdd: async () => {},
        issueStatus: "in_progress",
        activeRun: {
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
          },
      });

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
      renderThread({
        comments: [],
        interactions: [
            questionInteraction(
              `question-${adapterType}`,
              "Which legacy path should continue?",
              "2026-08-25T18:00:01.000Z",
            ),
          ],
        onAdd: async () => {},
        onSubmitInteractionAnswers: async () => {},
        issueStatus: "in_progress",
        activeRun: {
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
          },
      });

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

describe.each([true, false])("Unanswered question history (conversationMode=%s)", conversationMode => {
  const old = questionInteraction("old", "Which color?", "2026-08-15T12:00:01Z");
  const newer = questionInteraction("new", "Which tone?", "2026-08-15T12:05:00Z");
  const movedOn = createLongThreadComments();
  const props = { conversationMode, issueId: "issue-1", currentUserId: "user-board", onAdd: async () => {}, onSubmitInteractionAnswers: vi.fn() };
  const takeover = () => container.querySelector('[data-testid="task-chat-composer-takeover"]');
  const pendingIndicator = () => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-pending-input-indicator"]');
  const dismiss = async () => {
    await act(async () => takeover()!.querySelector<HTMLButtonElement>('[aria-label^="Dismiss "]')!.click());
  };
  const click = async (text: string) => {
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent?.trim() === text);
    expect(button).toBeTruthy();
    await act(async () => button!.click());
  };

  it("leaves a compact, reopenable question on reload after moving on", async () => {
    render(<TaskChatThread {...props} comments={movedOn} interactions={[old]} />);
    expect(takeover()).toBeNull();
    expect(pendingIndicator()).toBeNull();
    const row = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-unanswered-question"]');
    expect(row?.textContent).toContain("Which color?");
    await act(async () => row!.click());
    expect(takeover()?.textContent).toContain("Which color?");
    await click("Yes");
    await click("Submit answers");
    expect(props.onSubmitInteractionAnswers).toHaveBeenCalledWith(old, [{ questionId: "old-question", optionIds: ["yes"] }]);
  });

  it("collapses a displayed question when a new user message arrives", async () => {
    render(<TaskChatThread {...props} comments={[]} interactions={[old]} />);
    expect(takeover()).not.toBeNull();
    await act(async () => render(<TaskChatThread {...props} comments={movedOn} interactions={[old]} />));
    expect(takeover()).toBeNull();
    expect(pendingIndicator()).toBeNull();
    expect(container.querySelector('[data-testid="task-chat-unanswered-question"]')).not.toBeNull();
  });

  it.each(["Cancel", "dismiss"])("leaves only the history card after %s on a fresh question", async action => {
    render(<TaskChatThread {...props} comments={[]} interactions={[old]} />);
    await click("Yes");
    if (action === "Cancel") await click("Cancel");
    else await dismiss();
    expect(takeover()).toBeNull();
    expect(pendingIndicator()).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Answer question: Which color?"]')!.click());
    expect(takeover()?.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Yes");
  });

  it("keeps multiple historical questions out of the composer after reopening and dismissing one", async () => {
    const anotherOld = questionInteraction("another-old", "Which format?", "2026-08-15T12:00:02Z");
    render(<TaskChatThread {...props} comments={movedOn} interactions={[old, anotherOld]} />);
    expect(container.querySelectorAll('[data-testid="task-chat-unanswered-question"]')).toHaveLength(2);
    expect(pendingIndicator()).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Answer question: Which color?"]')!.click());
    expect(takeover()?.textContent).toContain("Which color?");
    expect(takeover()?.textContent).not.toContain("2 pending");
    await dismiss();
    expect(takeover()).toBeNull();
    expect(pendingIndicator()).toBeNull();
  });

  it("counts and cycles approvals without including fresh or historical question cards", async () => {
    const approval = { ...planReviewInteraction(), id: "approval", title: "Approve the outline?", payload: { version: 1, prompt: "Approve the outline?" } } as IssueThreadInteraction;
    const nextApproval = { ...approval, id: "next-approval", title: "Approve the note?", createdAt: new Date("2026-08-23T10:02:00Z"), payload: { version: 1, prompt: "Approve the note?" } } as IssueThreadInteraction;
    render(<TaskChatThread {...props} comments={movedOn} interactions={[old, newer, approval, nextApproval]} />);
    expect(takeover()?.textContent).toContain("Approve the note?");
    await click("2 pending");
    expect(takeover()?.textContent).toContain("Approve the outline?");
    await click("2 pending");
    expect(takeover()?.textContent).toContain("Approve the note?");
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Answer question: Which color?"]')!.click());
    expect(takeover()?.textContent).toContain("Which color?");
    expect(takeover()?.textContent).toContain("2 pending");
    expect(takeover()?.textContent).not.toContain("3 pending");
    await dismiss();
    expect(pendingIndicator()?.textContent).toContain("2 pending inputs");
    await act(async () => pendingIndicator()!.click());
    expect(takeover()?.textContent).toContain("Approve the note?");
  });

  it("opens the new question but can reopen the exact historical native question", async () => {
    const nativeOld = { ...old, sourceRunId: "old-run", payload: { ...old.payload, runtimeRequestId: "old-request" } } as IssueThreadInteraction;
    render(<TaskChatThread {...props} comments={movedOn} interactions={[nativeOld, newer]} />);
    expect(takeover()?.textContent).toContain("Which tone?");
    const oldRow = container.querySelector<HTMLButtonElement>('[aria-label="Answer question: Which color?"]');
    await act(async () => oldRow!.click());
    expect(takeover()?.textContent).toContain("Which color?");
    expect(takeover()?.textContent).not.toContain("2 pending");
    render(<TaskChatThread {...props} comments={[...movedOn]} interactions={[nativeOld, newer]} />);
    expect(takeover()?.textContent).toContain("Which color?");
    await dismiss();
    expect(pendingIndicator()).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Answer question: Which tone?"]')!.click());
    expect(takeover()?.textContent).toContain("Which tone?");
  });

  it.each([true, false])("only collapses the question after a successful send (success=%s)", async success => {
    const onAdd = success ? vi.fn().mockResolvedValue(undefined) : vi.fn().mockRejectedValue(new Error("Message not sent"));
    render(<TaskChatThread {...props} comments={[]} interactions={[old]} onAdd={onAdd} />);
    await click("Yes");
    await act(async () => editorCallbacks.change("Let's talk about tasks instead."));
    const send = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-send"]');
    expect(send?.disabled).toBe(false);
    await act(async () => send!.click());
    expect(onAdd).toHaveBeenCalledTimes(1);
    if (success) {
      expect(takeover()).toBeNull();
      expect(pendingIndicator()).toBeNull();
      await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="task-chat-unanswered-question"]')!.click());
    }
    expect(takeover()).not.toBeNull();
    expect(takeover()?.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Yes");
    expect(container.querySelector('[data-testid="task-chat-unanswered-question"]')).not.toBeNull();
  });

  it.each(["Cancel", "dismiss"])("keeps a fresh question dismissed after remounting (%s)", async action => {
    const show = () => render(<TaskChatThread {...props} comments={[]} interactions={[old]} />);
    show();
    await click("Yes");
    if (action === "Cancel") await click("Cancel");
    else await dismiss();
    flushSync(() => root!.unmount());
    root = createRoot(container);
    show();
    expect(takeover()).toBeNull();
    expect(pendingIndicator()).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Answer question: Which color?"]')!.click());
    expect(takeover()?.querySelector('[role="radio"][aria-checked="true"]')?.textContent).toContain("Yes");
  });

  it("shows a newly asked question after dismissing an older one", async () => {
    render(<TaskChatThread {...props} comments={[]} interactions={[old]} />);
    await dismiss();
    await act(async () => render(<TaskChatThread {...props} comments={[]} interactions={[old, newer]} />));
    expect(takeover()?.textContent).toContain("Which tone?");
    expect(takeover()?.textContent).not.toContain("Which color?");
    expect(container.querySelectorAll('[data-testid="task-chat-unanswered-question"]')).toHaveLength(2);
  });

  it("preserves a question dismissal saved by another tab", async () => {
    render(<TaskChatThread {...props} comments={[]} interactions={[old]} />);
    // The other tab saves after this thread has loaded its dismissal state.
    localStorage.setItem("paperclip:task-question-dismissals:user-board:issue-1", JSON.stringify([newer.id]));
    await dismiss();
    flushSync(() => root!.unmount());
    root = createRoot(container);
    render(<TaskChatThread {...props} comments={[]} interactions={[old, newer]} />);
    expect(takeover()).toBeNull();
    expect(pendingIndicator()).toBeNull();
    expect(container.querySelectorAll('[data-testid="task-chat-unanswered-question"]')).toHaveLength(2);
  });

  it("scopes dismissal to the person and task", async () => {
    const show = (userId: string, issueId: string) => render(<TaskChatThread {...props} currentUserId={userId} issueId={issueId} comments={[]} interactions={[old]} />);
    show("user-board", "issue-1");
    await dismiss();
    flushSync(() => root!.unmount());
    root = createRoot(container);
    show("another-user", "issue-1");
    expect(takeover()).not.toBeNull();
    flushSync(() => root!.unmount());
    root = createRoot(container);
    show("user-board", "issue-2");
    expect(takeover()).not.toBeNull();
  });
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

  it("uses master's production composer and gutters when Streamlined UI is off", () => {
    streamlinedState.enabled = false;
    render(<TaskChatThread comments={[]} onAdd={async () => {}} />);

    const dock = container.querySelector(
      '[data-testid="task-chat-composer-dock"]',
    );
    const composer = container.querySelector(".paperclip-task-chat-composer");
    const send = container.querySelector(
      '[data-testid="task-chat-composer-send"]',
    );

    expect(dock?.classList).not.toContain("md:px-0");
    expect(dock?.classList).not.toContain("md:pb-4");
    expect(dock?.classList).toContain("bg-background/80");
    expect(dock?.classList).toContain("pt-1");
    expect(dock?.classList).not.toContain("-mt-(--radius-task-composer)");
    expect(composer?.classList).not.toContain("border");
    expect(composer?.classList).toContain("bg-card");
    expect(send?.classList).toContain("rounded-full");
    expect(send?.classList).not.toContain("rounded-md");
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

  it.each((["native", "legacy"] as const).flatMap(runtimeMode => [true, false].flatMap(streamlined => [true, false].map(recoveryIsLatest => ({ runtimeMode, streamlined, recoveryIsLatest })))))
    ("keeps the last adjacent error for $runtimeMode (streamlined=$streamlined, recoveryIsLatest=$recoveryIsLatest)", ({ runtimeMode, streamlined, recoveryIsLatest }) => {
      streamlinedState.enabled = streamlined;
      render(<TaskChatThread
        comments={[noLivePathComment]} onAdd={async () => {}} showComposer={false} issueStatus="blocked"
        onTryAgainNoLiveExecutionPath={async () => {}}
        linkedRuns={[{
          runId: "failed-run", status: "failed", runtimeMode, agentId: "agent-1", agentName: "Coder",
          adapterType: runtimeMode === "native" ? "paperclip_runner" : "claude_local",
          createdAt: "2026-08-26T11:58:00.000Z", startedAt: "2026-08-26T11:58:01.000Z",
          finishedAt: recoveryIsLatest ? "2026-08-26T11:59:00.000Z" : "2026-08-26T12:01:00.000Z",
          errorCode: "runner_exited",
        }]}
      />);
      expect(container.textContent?.includes("Run failed")).toBe(!recoveryIsLatest);
      expect(container.textContent?.includes("No live execution path")).toBe(recoveryIsLatest);
      expect(container.querySelector(".border-dashed")).toBeNull();
      expect(container.querySelectorAll('button[data-testid$="try-again"]')).toHaveLength(1);
    });

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
    expect(
      container.querySelector(
        '[data-testid="task-chat-no-live-path-try-again"]',
      ),
    ).toBeNull();
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

    renderThread({
      comments: createLongThreadComments(),
      onAdd: async () => {},
      issueStatus: "blocked",
      blockedBy: [
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
      ],
      blockerAttention: {
        state: "needs_attention",
        reason: "attention_required",
        unresolvedBlockerCount: 2,
        coveredBlockerCount: 0,
        stalledBlockerCount: 0,
        attentionBlockerCount: 1,
        sampleBlockerIdentifier: "PAP-777",
        sampleStalledBlockerIdentifier: null,
        terminalBlockerIssueId: terminalBlocker.id,
      },
    });

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-blocker-links"]',
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.getAttribute("data-placement")).toBe("top");
    expect(notices[1]?.getAttribute("data-placement")).toBe("bottom");
    expect(notices[0]?.textContent).toContain(
      "Blocked byPAP-600Waiting in review",
    );
    expect(notices[0]?.textContent).toContain("Root blockerPAP-777Actual work");
    expect(notices[1]?.textContent).toContain(
      "Still blocked byPAP-600Waiting in review",
    );
    expect(notices[1]?.textContent).toContain(
      "Root blocker remainsPAP-777Actual work",
    );
    for (const notice of notices) {
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

    renderThread({
      comments: createLongThreadComments(),
      onAdd: async () => {},
      issueStatus: "blocked",
      liveIssueIds: new Set(["direct-running", "terminal-running"]),
      blockerAttention: {
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
      },
      blockedBy: [
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
      ],
    });

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-live-work-links"]',
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]?.getAttribute("data-placement")).toBe("top");
    expect(notices[1]?.getAttribute("data-placement")).toBe("bottom");
    expect(notices[0]?.textContent).toContain("Waiting on live work");
    expect(notices[1]?.textContent).toContain("Still waiting on live work");
    for (const notice of notices) {
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
      expect(
        notice.querySelector('[data-testid="task-chat-live-work-step"] > a'),
      ).not.toBeNull();
      expect(
        notice.querySelector('[data-testid="task-chat-live-work-step"] > span'),
      ).toBeNull();
    }
    expect(
      container.querySelector('[data-testid="task-chat-blocker-links"]'),
    ).toBeNull();
  });

  it("keeps the compact blocker rows when covered work is no longer live", () => {
    renderThread({
      comments: createLongThreadComments(),
      onAdd: async () => {},
      issueStatus: "blocked",
      liveIssueIds: new Set(),
      blockerAttention: {
        state: "covered",
        reason: "active_dependency",
        unresolvedBlockerCount: 1,
        coveredBlockerCount: 1,
        stalledBlockerCount: 0,
        attentionBlockerCount: 0,
        sampleBlockerIdentifier: "PAP-500",
        sampleStalledBlockerIdentifier: null,
        blockingTreeLive: false,
      },
      blockedBy: [
        {
          id: "direct-1",
          identifier: "PAP-500",
          title: "Direct dependency",
          status: "todo",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
        },
      ],
    });

    expect(
      container.querySelector('[data-testid="task-chat-live-work-links"]'),
    ).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="task-chat-blocker-links"]'),
    ).toHaveLength(2);
  });

  it("shows only the direct row when the blocker has no deeper unresolved leaf", () => {
    renderThread({
      comments: createLongThreadComments(),
      onAdd: async () => {},
      issueStatus: "blocked",
      blockedBy: [
        {
          id: "direct-1",
          identifier: "PAP-500",
          title: "Direct dependency",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
        },
      ],
    });

    expect(
      container.querySelectorAll('[data-testid="task-chat-blocker-links"]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain(
      "Blocked byPAP-500Direct dependency",
    );
    expect(container.textContent).not.toContain("Ultimately blocked by");
    expect(container.textContent).not.toContain("Root blocker");
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

    renderThread({
      comments: createLongThreadComments(),
      onAdd: async () => {},
      issueStatus: "blocked",
      blockedBy: [
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
      ],
      blockerAttention: {
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
      },
    });

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-blocker-links"]',
    );
    expect(notices[0]?.textContent).toContain(
      "Blocked byPAP-600Selected dependency",
    );
    expect(notices[0]?.textContent).toContain(
      "Root blockerPAP-650Stalled intermediate review",
    );
    expect(notices[1]?.textContent).toContain(
      "Still blocked byPAP-600Selected dependency",
    );
    expect(notices[1]?.textContent).toContain(
      "Root blocker remainsPAP-650Stalled intermediate review",
    );
    expect(container.textContent).not.toContain("Unrelated dependency");
    expect(container.textContent).not.toContain("Deeper structural leaf");
  });

  it("auto-follows the new bottom blocker row when a pinned thread becomes blocked", () => {
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
      comments: createLongThreadComments(),
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

  it("keeps a short blocked thread to one top affordance", () => {
    renderThread({
      comments: createLongThreadComments().slice(0, 1),
      onAdd: async () => {},
      issueStatus: "blocked",
      blockedBy: [
        {
          id: "direct-1",
          identifier: "PAP-500",
          title: "Direct dependency",
          status: "todo",
          priority: "medium",
          assigneeAgentId: null,
          assigneeUserId: null,
        },
      ],
    });

    const notices = container.querySelectorAll(
      '[data-testid="task-chat-blocker-links"]',
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.getAttribute("data-placement")).toBe("top");
  });

  it("does not show blocker rows outside the blocked state", () => {
    renderThread({
      comments: createLongThreadComments(),
      onAdd: async () => {},
      issueStatus: "in_progress",
      blockedBy: [
        {
          id: "direct-1",
          identifier: "PAP-500",
          title: "Direct dependency",
          status: "in_progress",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
        },
      ],
    });

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

    renderThread({
      comments: [queuedComment],
      onAdd: async () => {},
      onInterruptQueued: onInterruptQueued,
    });

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
    renderThread({
      comments: [
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
      ],
      onAdd: async () => {},
      onInterruptQueued: async () => {},
      interruptingQueuedRunId: "run-active",
    });

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

  it("hides queued actions while paused and restores the queue after resume", () => {
    const onSteerQueuedComment = vi.fn(async () => {});
    const props = {
      comments: [queuedComment],
      onAdd: async () => {},
      queuedCommentQueue: queue,
      onEditQueuedComment: async () => {},
      onReorderQueuedComments: async () => {},
      onSteerQueuedComment,
      onDiscardQueuedComment: async () => {},
    };
    render(<TaskChatThread {...props} />);
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).not.toBeNull();

    render(<TaskChatThread {...props} composerPause={{ scope: "leaf", onResume: () => {} }} />);
    expect(container.querySelector('[data-testid="paused-composer-takeover"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
    expect(onSteerQueuedComment).not.toHaveBeenCalled();

    render(<TaskChatThread {...props} />);
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).not.toBeNull();
    expect(occurrenceCount(queuedComment.body)).toBe(1);
  });

  it("hides legacy transcript interrupt actions while paused", () => {
    renderThread({
      comments: [{ ...queuedComment, queueState: "queued", queueTargetRunId: "run-1" }],
      onAdd: async () => {},
      onInterruptQueued: async () => {},
      composerPause: { scope: "leaf", onResume: () => {} },
    });
    expect(container.querySelector('[data-testid="paused-composer-takeover"]')).not.toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Interrupt")).toBe(false);
  });

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

  it.each(["steer", "interrupt"] as const)("preserves inline %s errors after the optimistic last row clears", async action => {
    let rejectDelivery!: (error: Error) => void;
    const delivery = new Promise<void>((_, reject) => { rejectDelivery = reject; });
    const actionQueue = { ...queue, protocol: action === "interrupt" ? "legacy" as const : queue.protocol };
    const props = { comments: [queuedComment], onAdd: async () => {}, queuedCommentQueue: actionQueue,
      onSteerQueuedComment: () => delivery, onInterruptQueued: () => delivery };
    render(<TaskChatThread {...props} />);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-testid="task-chat-queued-${action}-queued-prp-1"]`)!.click();
    });
    render(<TaskChatThread {...props} queuedCommentQueue={null} />);
    expect(container.querySelector('[data-testid="task-chat-queued-messages"]')).toBeNull();
    await act(async () => {
      rejectDelivery(new Error("Connection lost"));
      await delivery.catch(() => undefined);
    });
    await act(async () => { render(<TaskChatThread {...props} />); });
    expect(container.textContent).toContain(action === "steer"
      ? "Couldn’t steer. Message is still queued." : "Couldn’t interrupt. Message is still queued.");
    expect(occurrenceCount(queuedComment.body)).toBe(1);
  });

  it.each(["run-1", null])("offers legacy interruption only with a live target (%s)", (targetRunId) => {
    const onInterruptQueued = vi.fn(async () => {});
    renderThread({
      comments: [
        {
          ...queuedComment,
          clientStatus: "queued",
          queueTargetRunId: "run-1",
        },
      ],
      onAdd: async () => {},
      onInterruptQueued: onInterruptQueued,
      queuedCommentQueue: {
        ...queue,
        targetRunId,
        protocol: "legacy",
        steeringDisposition: "unsupported",
      },
      onEditQueuedComment: async () => {},
      onReorderQueuedComments: async () => {},
      onSteerQueuedComment: async () => {},
      onDiscardQueuedComment: async () => {},
    });

    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-queued-prp-1"]',
      ),
    ).not.toBeNull();
    expect(occurrenceCount(queuedComment.body)).toBe(1);
    expect(container.textContent).not.toContain("QueuedInterrupt");

    const interrupt = container.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-queued-interrupt-queued-prp-1"]',
    );
    if (targetRunId) {
      expect(interrupt).not.toBeNull();
      flushSync(() => interrupt!.click());
      expect(onInterruptQueued).toHaveBeenCalledWith(targetRunId);
    } else {
      expect(interrupt).toBeNull();
      expect(onInterruptQueued).not.toHaveBeenCalled();
    }
  });

  it("cancels an optimistic queued row locally before server acknowledgement", async () => {
    const onCancelQueued = vi.fn();
    renderThread({
      comments: [],
      onAdd: async () => {},
      onCancelQueued: onCancelQueued,
      queuedCommentQueue: {
        ...queue,
        queueId: null,
        entries: [
          {
            ...queue.entries[0],
            comment: {
              ...queuedComment,
              id: "optimistic-local-1",
              body: "Delete before acknowledgement",
            },
            canEdit: false,
          },
        ],
      },
      onEditQueuedComment: async () => {},
      onReorderQueuedComments: async () => {},
      onSteerQueuedComment: async () => {},
      onDiscardQueuedComment: async () => {},
    });

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="task-chat-queued-discard-optimistic-local-1"]',
        )
        ?.click();
    });

    expect(onCancelQueued).toHaveBeenCalledWith("optimistic-local-1");
    expect(
      container.querySelector(
        '[data-testid="task-chat-queued-message-optimistic-local-1"]',
      ),
    ).toBeNull();
  });
});

describe("TaskChatThread mobile composer dock (PAP-495)", () => {
  it("pins the composer to the nav-aware bottom offset so its action row clears the auto-hiding bottom nav", () => {
    sidebarState.isMobile = true;

    renderThread({
      comments: [],
      onAdd: async () => {},
      draftKey: "task-chat-draft:issue-mobile",
    });

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

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: activeRun,
      composerAccessory: <div data-testid="composer-accessory">Monitor</div>,
    });

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

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
        ...activeRun,
        status: "succeeded",
        finishedAt: "2026-08-24T12:01:00.000Z",
      },
    });
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

    renderThread({
      comments: [comment],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
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
      },
    });

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

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
        ...baseRun,
        currentStatusMessage: "Syncing workspace to environment",
      },
    });

    const tail = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail).not.toBeNull();
    expect(tail!.textContent).toContain("Syncing workspace to environment");
    expect(tail!.textContent).not.toContain("Waiting for transcript...");

    // Without a runtime status, the working indicator remains the only visible activity.
    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: { ...baseRun, id: "run-prep-2" },
    });
    const tail2 = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail2!.textContent).toContain("Working");
    expect(tail2!.textContent).not.toContain("Waiting for transcript...");
  });

  it("does not send a workspace bootstrap failure to connection settings", () => {
    const run = { id: "workspace-prep", status: "running" as const, invocationSource: "issue", triggerDetail: null,
      startedAt: "2026-09-15T10:00:00Z", finishedAt: null, createdAt: "2026-09-15T10:00:00Z",
      agentId: "agent-1", agentName: "Worker", adapterType: "process" };
    render(<TaskChatThread comments={[]} onAdd={async () => {}} issueStatus="in_progress" activeRun={run} />);
    render(<TaskChatThread comments={[]} onAdd={async () => {}} issueStatus="in_progress" linkedRuns={[
      { ...run, runId: run.id, status: "failed", errorCode: "workspace_git_scan_timeout", finishedAt: "2026-09-15T10:00:10Z" },
    ]} />);
    expect(container.textContent).toContain("Workspace setup failed before the agent started.");
    expect(container.textContent).not.toContain("Review the task’s connection");
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

    renderThread({
      comments: [],
      onAdd: async () => {},
      issueStatus: "in_progress",
      activeRun: {
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
      },
    });

    const tail = container.querySelector(
      '[data-testid="task-chat-live-transcript"]',
    );
    expect(tail).not.toBeNull();
    // Clean content survives: streamed reply markdown + compact phase summary.
    expect(tail!.textContent).toContain(
      "Streaming through the shared renderer",
    );
    const phaseSummary = tail!.querySelector<HTMLButtonElement>(
      '[data-testid="task-chat-activity-phase-toggle"]',
    );
    expect(phaseSummary?.getAttribute("aria-expanded")).toBe("false");
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

  it.each([false, true])("resolves canonical input with stale adapter metadata (saved card: %s)", async (hasSavedCard) => {
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
              options: [{ id: "api", label: "Starter API" }, { id: "worker", label: "Background worker" }],
            },
          ],
        },
      },
    ]);
    const resolveRuntimeRequest = vi
      .spyOn(heartbeatsApi, "resolveRuntimeRequest")
      .mockResolvedValue({} as never);

    const onSubmitInteractionAnswers = vi.fn().mockResolvedValue(undefined);
    const saved = {
      ...questionInteraction("saved-question", "What should the server do?", "2026-08-23T20:00:00.000Z"),
      sourceRunId: "run-input", continuationPolicy: "none",
      payload: { version: 1, runtimeRequestId: "question-1",
        questionSet: transcriptState.transcriptByRun.get("run-input")[0].questionSet,
        questions: [{ id: "goal", prompt: "What should the server do?", required: true, selectionMode: "single",
          options: [{ id: "api", label: "Starter API" }, { id: "worker", label: "Background worker" }] }] },
    } as IssueThreadInteraction;
    render(
      <TaskChatThread
        interactions={hasSavedCard ? [saved] : []}
        onSubmitInteractionAnswers={onSubmitInteractionAnswers}
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

    if (hasSavedCard) {
      expect(resolveRuntimeRequest).not.toHaveBeenCalled();
      expect(onSubmitInteractionAnswers).toHaveBeenCalledWith(saved, [{ questionId: "goal", optionIds: ["api"] }]);
    } else expect(resolveRuntimeRequest).toHaveBeenCalledWith({
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

  it.each(["done", "yielded"])(
    "renders one native turn while its completion comment refresh is delayed: %s",
    (disposition) => {
      const runId = "native-delayed-comment";
      const summary = "DELAYED-CANONICAL-REPLY";
      nativeTranscriptState.transcriptByRun.set(runId, [
        assistantEntry("2026-08-07T00:00:01Z", "UNIQUE-PROGRESS-LINE", "progress"),
        assistantEntry("2026-08-07T00:00:02Z", summary, "final"),
        {
          kind: "run_result",
          ts: "2026-08-07T00:00:03Z",
          disposition,
          summary,
          objectiveSatisfied: true,
          verification: [],
          remainingWork: [],
          blocker: null,
          artifacts: [],
          ...(disposition === "yielded"
            ? {
                acceptedResponseWake: {
                  runId,
                  sourceEventId: "accepted-result",
                },
              }
            : {}),
        },
        {
          kind: "run_terminal",
          ts: "2026-08-07T00:00:04Z",
          turnState: "completed",
          runState: "succeeded",
          disposition,
        },
      ]);
      const activeRun = {
        id: runId,
        runtimeMode: "native" as const,
        status: "running",
        invocationSource: "issue" as const,
        triggerDetail: null,
        startedAt: "2026-08-07T00:00:00Z",
        createdAt: "2026-08-07T00:00:00Z",
        finishedAt: null,
        agentId: "agent-1",
        agentName: "Runner",
        adapterType: "paperclip_runner",
      };
      const linkedRun = {
        ...activeRun,
        runId,
        status: "succeeded",
        finishedAt: "2026-08-07T00:00:05Z",
        resultJson: {
          nativeResult: {
            schema: "paperclip.run_result.v1",
            reportedWorkDisposition: disposition,
            summary,
          },
          presentationDecision: {
            schema: "paperclip.run_presentation_decision.v1",
            chosenSource: "existing_issue_comment",
            commentId: "delayed-comment",
          },
        },
      };
      renderThread({
        comments: [],
        onAdd: async () => {},
        issueStatus: "in_progress",
        activeRun: activeRun,
      });
      // The terminal run/event query wins the race, but the canonical comment
      // request is still pending. The settled answer already owns the turn.
      renderThread({
        comments: [],
        onAdd: async () => {},
        issueStatus: "in_progress",
        linkedRuns: [linkedRun],
      });
      expect(container.textContent?.split("UNIQUE-PROGRESS-LINE")).toHaveLength(
        2,
      );
      expect(container.textContent?.split(summary)).toHaveLength(2);
      expect(
        container.querySelector('[data-testid="task-chat-live-transcript"]'),
      ).toBeNull();
      renderThread({
        comments: [
          {
            id: "delayed-comment",
            companyId: "company-1",
            issueId: "issue-1",
            authorType: "agent",
            authorAgentId: "agent-1",
            authorUserId: null,
            createdByRunId: runId,
            runId,
            body: summary,
            presentation: null,
            metadata: null,
            createdAt: new Date("2026-08-07T00:00:05Z"),
            updatedAt: new Date("2026-08-07T00:00:05Z"),
          },
        ],
        onAdd: async () => {},
        issueStatus: "in_progress",
        linkedRuns: [linkedRun],
      });
      expect(container.textContent?.split("UNIQUE-PROGRESS-LINE")).toHaveLength(
        2,
      );
      expect(container.textContent?.split(summary)).toHaveLength(2);
      expect(
        container.querySelector('[data-testid="task-chat-final-response"]'),
      ).toBeNull();
    },
  );

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

describe("TaskChatThread composer execution controls", () => {
  it.each(["process", "paperclip_runner"])("passes the task's stop action through for %s execution", async (adapterType) => {
    const onStop = vi.fn(async () => {});
    const run = {
      id: "task-run", status: "running", runtimeMode: adapterType === "process" ? "legacy" as const : "native" as const,
      invocationSource: "issue", triggerDetail: null, startedAt: "2026-09-09T12:00:00Z", finishedAt: null,
      createdAt: "2026-09-09T12:00:00Z", agentId: "agent-1", agentName: "Alex", adapterType,
    };
    render(<TaskChatThread comments={[]} onAdd={async () => {}} issueStatus="in_progress" activeRun={run} onCancelRun={onStop} stopScope="subtree" />);
    const button = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-stop"]')!;
    expect(button.title).toBe("Stop response");
    await act(async () => { button.click(); });
    expect(onStop).toHaveBeenCalledOnce();
    render(<TaskChatThread comments={[]} onAdd={async () => {}} issueStatus="in_progress" activeRun={run} onCancelRun={onStop} stopPending />);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-stop"]')?.disabled).toBe(true);
  });
  it("does not offer Stop for settled work even when a callback is available", () => {
    render(<TaskChatThread comments={[]} onAdd={async () => {}} issueStatus="todo" onCancelRun={vi.fn()} />);
    expect(container.querySelector('[data-testid="task-chat-composer-stop"]')).toBeNull();
  });
});

it("explains a missing provider runtime with an installation repair", () => {
  renderThread({
    comments: [],
    onAdd: async () => {},
    linkedRuns: [{
      runId: "missing-runtime", runtimeMode: "native", status: "failed", errorCode: "native_provider_runtime_missing",
      agentId: "agent-1", agentName: "Content Strategist", adapterType: "paperclip_runner",
      createdAt: "2026-10-11T11:19:08Z", startedAt: "2026-10-11T11:19:08Z", finishedAt: "2026-10-11T11:19:14Z",
    }],
  });
  expect(container.textContent).toContain("Runtime missing");
  const toggle = container.querySelector<HTMLButtonElement>('[data-testid="task-chat-collapsible-marker"] button[aria-expanded]')!;
  flushSync(() => toggle.click());
  expect(container.textContent).toContain("Reinstall or rebuild Paperclip");
  expect(container.textContent).toContain("test the agent's runtime");
});
