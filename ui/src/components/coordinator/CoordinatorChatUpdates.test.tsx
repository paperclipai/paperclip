// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTaskHandoff, DecisionHistoryItem, IssueThreadInteraction } from "@paperclipai/shared";
import { CoordinatorChatDecisionReceipt, CoordinatorChatReceiptStatus, useCoordinatorChatDecisionReceipts } from "./CoordinatorChatDecisionReceipts";
import { CoordinatorInteractionReceipt } from "./CoordinatorInteractionReceipt";
import { standaloneChatHandoffs, useCoordinatorChatTaskHandoffs, useLiveChatHandoffIds } from "./CoordinatorChatTaskHandoffs";
import { answeredAskUserQuestionsInteraction, pendingSuggestedTasksInteraction } from "@/fixtures/issueThreadInteractionFixtures";

const mocks = vi.hoisted(() => ({ get: vi.fn(), detach: vi.fn(), viewer: "viewer-a", enabled: true }));
vi.mock("@/api/client", () => ({ api: { get: mocks.get }, detachInflightGet: mocks.detach }));
vi.mock("@/hooks/useCoordinatorWorkspaceEnabled", () => ({ useCoordinatorWorkspaceEnabled: () => ({ enabled: mocks.enabled, userId: mocks.viewer }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, disableIssueQuicklook: _disableIssueQuicklook, ...props }: any) => <a href={to} {...props}>{children}</a> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root; let client: QueryClient;
beforeEach(() => {
  mocks.enabled = true; mocks.viewer = "viewer-a"; mocks.get.mockReset(); mocks.detach.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(async () => { await act(() => root.unmount()); host.remove(); client.clear(); });
const receipt = (id: string): DecisionHistoryItem => ({
  id, sourceKind: "issue_thread_interaction", sourceId: id, issueId: "task-id", issueIdentifier: "PAPER-102", issueTitle: "Write the post",
  agentId: "writer", agentName: "Mira", projectId: null, projectName: null, title: "Blog draft", outcome: "accepted", label: "Approved · v3",
  resolvedAt: "2026-10-26T12:00:00Z", resolvedByUserId: "viewer-a", resolvedByAgentId: null,
  href: `/issues/PAPER-102#document-plan&revision=exact-revision&interaction=${id}`, target: { kind: "issue_document", key: "plan", revisionId: "exact-revision" },
});
const handoff = (id: string, date: string, suggestionInteractionId: string | null = null): ConversationTaskHandoff => ({
  id: `chat_handoff:${id}`, issueId: id, identifier: `PAPER-${id}`, title: "Write the post", status: "todo", createdAt: date, sourceRunId: null, suggestionInteractionId,
});
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
function Receipts({ conversation = true }: { conversation?: boolean }) {
  const query = useCoordinatorChatDecisionReceipts("chat-id", conversation);
  const tasks = useCoordinatorChatTaskHandoffs("chat-id", conversation);
  return <><CoordinatorChatReceiptStatus query={query} />{query.receipts.map(item => <CoordinatorChatDecisionReceipt key={item.id} receipt={item} />)}<span data-tasks>{tasks.handoffs.length}</span></>;
}
async function paint(conversation = true) { await act(() => root.render(<QueryClientProvider client={client}><Receipts conversation={conversation} /></QueryClientProvider>)); await settle(); }

describe("Coordinator source-chat updates", () => {
  it("does not fetch task/chat projections outside an opted-in standing conversation", async () => {
    await paint(false); expect(mocks.get).not.toHaveBeenCalled();
    mocks.enabled = false; await paint(true); expect(mocks.get).not.toHaveBeenCalled();
  });
  it("loads older receipts without duplicates and links the exact recorded revision", async () => {
    mocks.get.mockImplementation(async (url: string) => url.includes("chat-handoffs") ? { items: [], nextCursor: null } : url.includes("cursor=") ? { items: [receipt("second"), receipt("first")], nextCursor: null } : { items: [receipt("first")], nextCursor: "older" });
    await paint();
    expect(host.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe(receipt("first").href);
    await act(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Load earlier decisions")!.click()); await settle();
    expect(host.querySelectorAll("[data-testid=coordinator-chat-decision-receipt]")).toHaveLength(2);
    expect(host.textContent).not.toContain("Load earlier decisions");
    expect(client.getQueryData(["issues", "decision-receipts", "chat-id", "viewer-a"])).toBeDefined();
    expect(mocks.detach).toHaveBeenCalledWith("/issues/chat-id/decision-receipts?limit=100");
    expect(mocks.get).toHaveBeenCalledWith("/issues/chat-id/chat-handoffs?limit=100", expect.objectContaining({ cache: "no-store" }));
    mocks.viewer = "viewer-b"; mocks.get.mockImplementation(async () => ({ items: [], nextCursor: null })); await paint();
    expect(host.querySelectorAll("[data-testid=coordinator-chat-decision-receipt]")).toHaveLength(0);
  });
  it("only suppresses native handoffs whose accepted suggestion is already rendered", () => {
    const suggestion = { ...pendingSuggestedTasksInteraction, status: "accepted" } as IssueThreadInteraction;
    const records = [handoff("1", "2026-10-26T12:00:00Z", suggestion.id), handoff("2", "2026-10-26T12:01:00Z"), handoff("3", "2026-10-26T12:02:00Z", "unloaded-older-suggestion")];
    expect(standaloneChatHandoffs(records, [suggestion]).map(item => item.issueId)).toEqual(["2", "3"]);
  });
  it("animates new live handoffs without replaying history, older pages, or navigation", async () => {
    function Observation({ rows, scope }: { rows: ConversationTaskHandoff[]; scope: string }) {
      const live = useLiveChatHandoffIds(scope, rows, true);
      return <span>{[...live].join(",")}</span>;
    }
    const current = handoff("2", "2026-10-26T12:00:00Z");
    const older = handoff("1", "2026-10-25T12:00:00Z");
    const added = handoff("3", "2026-10-26T12:01:00Z");
    await act(() => root.render(<Observation rows={[current]} scope="first" />)); expect(host.textContent).toBe("");
    await act(() => root.render(<Observation rows={[current, older]} scope="first" />)); expect(host.textContent).toBe("");
    await act(() => root.render(<Observation rows={[added, current, older]} scope="first" />)); expect(host.textContent).toBe(added.id);
    await act(() => root.render(<Observation rows={[added, current, older]} scope="second" />)); expect(host.textContent).toBe("");
  });
});

 it("anchors a local answered question to its answer without leaving the chat", async () => {
    const interaction = answeredAskUserQuestionsInteraction;
    const answer = document.createElement("div");
    answer.id = `comment-interaction-response:${interaction.id}`;
    const scroll = vi.fn(); answer.scrollIntoView = scroll;
    host.append(answer);
    await act(() => root.render(<CoordinatorInteractionReceipt interaction={interaction} />));
    // Root rendering replaces host children, so the transcript target is a sibling.
    document.body.append(answer);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`#${answer.id}`);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(() => { link.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "auto" });
    answer.remove();
  });
