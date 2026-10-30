// @vitest-environment jsdom
import { act, forwardRef, useImperativeHandle, type ForwardedRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTaskHandoff, IssueDocument, IssueThreadInteraction } from "@paperclipai/shared";
import { TaskChatThread } from "./TaskChatThread";
import { CoordinatorPresentation } from "./coordinator/CoordinatorPresentation";
import { ThemeProvider } from "@/context/ThemeContext";
import { pendingSuggestedTasksInteraction } from "@/fixtures/issueThreadInteractionFixtures";
import type { TranscriptEntry } from "@/adapters";
import type { LiveRunForIssue } from "@/api/heartbeats";
import type { IssueChatLinkedRun } from "@/lib/issue-chat-messages";

const state = vi.hoisted(() => ({
  coordinator: true,
  transcripts: new Map<string, TranscriptEntry[]>(),
  handoffs: [] as ConversationTaskHandoff[],
  plan: null as IssueDocument | null,
}));
vi.mock("@/components/transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), isInitialHydrating: false }),
}));
vi.mock("@/components/transcript/useNativeRunTranscripts", () => ({
  useNativeRunTranscripts: () => ({ transcriptByRun: new Map(state.transcripts), errorsByRun: new Map(),
    terminalHydratedRunIds: new Set(state.transcripts.keys()) }),
}));
vi.mock("@/hooks/useIssuePlanDocument", () => ({ useIssuePlanDocument: () => ({ data: state.plan }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("@/hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({
  useCoordinatorWorkspaceEnabled: () => ({ enabled: state.coordinator, loaded: true, userId: "viewer" }),
}));
vi.mock("@/components/coordinator/CoordinatorChatTaskHandoffs", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/coordinator/CoordinatorChatTaskHandoffs")>(),
  useCoordinatorChatTaskHandoffs: () => ({ handoffs: state.coordinator ? state.handoffs : [], isSuccess: true, enabled: state.coordinator }),
}));
vi.mock("@/components/coordinator/CoordinatorChatDecisionReceipts", async importOriginal => ({
  ...await importOriginal<typeof import("@/components/coordinator/CoordinatorChatDecisionReceipts")>(),
  useCoordinatorChatDecisionReceipts: () => ({ receipts: [], enabled: false }),
}));
vi.mock("@/components/coordinator/CoordinatorChatPendingQuestions", () => ({
  useCoordinatorChatPendingQuestions: () => ({ questions: [], enabled: false }),
  CoordinatorChatQuestionStatus: () => null,
}));
vi.mock("@/api/issues", async importOriginal => ({
  ...await importOriginal<typeof import("@/api/issues")>(),
  issuesApi: { summaries: vi.fn(async () => []) },
}));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues/chat", hash: "", search: "", key: "test", state: null }),
  Link: ({ to, children, ...props }: { to: string; children: React.ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/components/MarkdownEditor", () => ({
  MarkdownEditor: forwardRef(function MockMarkdownEditor({ value }: { value: string }, ref: ForwardedRef<unknown>) {
    useImperativeHandle(ref, () => ({ insertMarkdown: () => {}, focus: () => {} }));
    return <div>{value}</div>;
  }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
const at = (second: number) => `2026-10-26T12:00:${String(second).padStart(2, "0")}Z`;
const sourceRun: IssueChatLinkedRun = {
  runId: "source-run", status: "succeeded", runtimeMode: "native", adapterType: "paperclip_runner",
  agentId: "agent", agentName: "Assistant", createdAt: at(0), startedAt: at(0), finishedAt: at(10),
};
const comment = (id: string, body: string, second: number, runId?: string) => ({
  id, body, companyId: "company", issueId: "chat", authorType: runId ? "agent" as const : "user" as const,
  authorAgentId: runId ? "agent" : null, authorUserId: runId ? null : "viewer", runId,
  createdByRunId: runId ?? null, presentation: null, metadata: null,
  createdAt: new Date(at(second)), updatedAt: new Date(at(second)),
});
const handoff = (id = "task", sourceRunId: string | null = "source-run", second = 3): ConversationTaskHandoff => ({
  id: `chat_handoff:${id}`, issueId: id, identifier: `PAPER-${id}`, title: `Created ${id}`, status: "todo",
  createdAt: at(second), sourceRunId, suggestionInteractionId: null,
});
const suggestion = (status: "pending" | "accepted"): IssueThreadInteraction => ({
  ...pendingSuggestedTasksInteraction, id: "suggestion", companyId: "company", issueId: "chat", sourceRunId: "source-run",
  status, createdAt: new Date(at(3)), updatedAt: new Date(at(3)),
  result: status === "accepted" ? { version: 1, createdTasks: [{ clientKey: "post", issueId: "suggested-task", identifier: "PAPER-101", title: "Suggested task" }] } : null,
});
beforeEach(() => {
  state.coordinator = true;
  state.handoffs = [];
  state.plan = null;
  state.transcripts.clear();
  state.transcripts.set("source-run", [
    { kind: "assistant", channel: "progress", text: "Preparing the task.", ts: at(2) },
    { kind: "thinking", text: "Check the requested scope.", ts: at(4) },
    { kind: "assistant", channel: "final", text: "Your task is ready.", ts: at(9) },
  ]);
  localStorage.clear();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); client.clear(); vi.restoreAllMocks(); });
async function paint(overrides: Partial<React.ComponentProps<typeof TaskChatThread>> = {}) {
  await act(() => root.render(<QueryClientProvider client={client}><ThemeProvider>
    <CoordinatorPresentation value={state.coordinator}>
      <TaskChatThread issueId="chat" conversationMode currentUserId="viewer" comments={[
        comment("final", "Your task is ready.", 9, "source-run"), comment("next", "A later question.", 20),
      ]} linkedRuns={[sourceRun]} onAdd={async () => {}} {...overrides} />
    </CoordinatorPresentation>
  </ThemeProvider></QueryClientProvider>));
}
const anchor = (id: string) => host.querySelector(`[data-thread-anchor="${id}"]`)!;
const before = (earlier: Element, later: Element) => expect(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

describe("Coordinator task creation ordering", () => {
  it("keeps the saved plan before its resulting document even when both belong to one native run", async () => {
    state.plan = { id: "plan", issueId: "chat", companyId: "company", key: "plan", title: "Plan", body: "Draft the concepts.",
      format: "markdown", latestRevisionId: "plan-rev", latestRevisionNumber: 1,
      createdAt: new Date(at(2)), updatedAt: new Date(at(2)), updatedByAgentId: "agent" } as IssueDocument;
    const result = { ...state.plan, id: "concepts", key: "concepts", title: "Concept document", body: "The concepts.",
      createdAt: new Date(at(5)), updatedAt: new Date(at(5)) };
    await paint({ documents: [state.plan, result], conversationMode: false });
    const plan = host.querySelector('[data-testid="task-chat-plan-preview"]')!;
    const output = host.querySelector('a[href="#document-concepts"]')!;
    expect(plan).toBeTruthy();
    expect(output).toBeTruthy();
    before(plan, output);
    expect(host.querySelectorAll('[data-testid="task-chat-plan-preview"]')).toHaveLength(1);
  });
  it("puts direct task cards after their complete source reply, before a later conversation", async () => {
    state.handoffs = [handoff(), handoff("unknown", null, 5)];
    await paint();
    before(anchor("final"), anchor("chat_handoff:task"));
    before(anchor("chat_handoff:task"), anchor("next"));
    before(anchor("chat_handoff:unknown"), anchor("final"));
    expect(host.querySelectorAll('[data-thread-anchor="chat_handoff:task"]')).toHaveLength(1);
  });

  it("puts cards after transcript-only responses and every segment of a steered turn", async () => {
    state.handoffs = [handoff()];
    await paint({ comments: [
      { ...comment("steer", "Keep the task small.", 5), steeredIntoRunId: "source-run", conversationAnchorAt: at(5) },
      comment("next", "A later question.", 20),
    ] });
    before(anchor("source-run:turn:1"), anchor("chat_handoff:task"));
    before(anchor("chat_handoff:task"), anchor("next"));
    expect(anchor("source-run:turn:1").textContent).toContain("Your task is ready.");
  });

  it("keeps a suggestion in the same end-of-turn slot when acceptance creates its task", async () => {
    await paint({ interactions: [suggestion("pending")] });
    const card = anchor("interaction:suggestion");
    before(anchor("final"), card);
    before(card, anchor("next"));
    state.handoffs = [{ ...handoff("suggested-task"), suggestionInteractionId: "suggestion" }];
    await paint({ interactions: [suggestion("accepted")] });
    expect(anchor("interaction:suggestion")).toBe(card);
    expect(card.querySelector(".coordinator-created-task")).not.toBeNull();
    expect(host.querySelector('[data-thread-anchor="chat_handoff:suggested-task"]')).toBeNull();
    before(anchor("final"), card);
    before(card, anchor("next"));
  });

  it("follows the live tail and stays after the final reply when the turn settles", async () => {
    state.handoffs = [handoff()];
    const live: LiveRunForIssue = { id: "source-run", agentId: "agent", agentName: "Assistant", adapterType: "paperclip_runner",
      runtimeMode: "native", status: "running", invocationSource: "on_demand", triggerDetail: null,
      createdAt: at(0), startedAt: at(0), finishedAt: null };
    await paint({ comments: [], linkedRuns: [{ ...sourceRun, status: "running", finishedAt: null }], liveRuns: [live] });
    before(host.querySelector('[data-testid="task-chat-live-transcript"]')!, anchor("chat_handoff:task"));
    await paint();
    before(anchor("final"), anchor("chat_handoff:task"));
    before(anchor("chat_handoff:task"), anchor("next"));
    expect(host.querySelectorAll('[data-thread-anchor="chat_handoff:task"]')).toHaveLength(1);
  });

  it("keeps classic suggestion chronology when Coordinator is disabled", async () => {
    state.coordinator = false;
    await paint({ interactions: [suggestion("accepted")] });
    before(anchor("interaction:suggestion"), anchor("final"));
  });
});
