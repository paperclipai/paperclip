// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentConversationsSidebar } from "./AgentConversationsSidebar";
import type { AgentConversationSidebarProps } from "./AgentConversationSidebar";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "@/api/client";
import { useOpenAgentChat } from "@/hooks/useAgentChatNavigation";
const state = vi.hoisted(() => ({ companyId: "company-a", navigate: vi.fn(), closeSidebar: vi.fn(), ensure: vi.fn(), getAgent: vi.fn(), newAgent: vi.fn() }));
const sidebarInputs = vi.hoisted(() => [] as Pick<AgentConversationSidebarProps, "existingChatAgentIds" | "unreadAgentIds" | "unreadMessageCounts">[]);
vi.mock("./AgentConversationSidebar", async importOriginal => {
  const original = await importOriginal<typeof import("./AgentConversationSidebar")>();
  return { AgentConversationSidebar: (props: AgentConversationSidebarProps) => {
    sidebarInputs.push({ existingChatAgentIds: props.existingChatAgentIds, unreadAgentIds: props.unreadAgentIds, unreadMessageCounts: props.unreadMessageCounts });
    return <original.AgentConversationSidebar {...props} />;
  } };
});
vi.mock("@/context/DialogContext", () => ({ useDialogActions: () => ({ openNewAgent: state.newAgent }) }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: true, setSidebarOpen: state.closeSidebar }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/A/chats/alice" }), useNavigate: () => state.navigate,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(), get: state.getAgent } }));
const issueUpdates = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/api/issues", () => ({ issuesApi: { update: issueUpdates } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { list: vi.fn(), ensure: state.ensure, create: state.ensure } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: () => ({ user: { id: "user-a" } }) } }));
vi.mock("./AgentAvatar", () => ({ AgentAvatar: () => null }));
const memberships = vi.hoisted(() => ({ agentMemberships: {} as Record<string, string> }));
vi.mock("@/api/resourceMemberships", () => ({ resourceMembershipsApi: {
  listMine: async () => ({ projectMemberships: {}, agentMemberships: memberships.agentMemberships, starredProjectIds: [], starredAgentIds: [], starredDocumentIds: [] }),
} }));
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const roster = ["alice", "bob"].map(id => ({ id, companyId: "company-a", name: id, urlKey: id, role: "general", title: "Teammate", status: "idle" } as Agent));
const chat = (id: string) => ({ id: `chat-${id}`, companyId: "company-a", conversationAgentId: id, conversationUserId: "user-a", updatedAt: id === "bob" ? "2026-09-02T00:00:00Z" : "2026-09-01T00:00:00Z" });
async function render(option?: boolean | (() => void)) {
  const compact = option === true;
  const onConversationOpened = typeof option === "function" ? option : undefined;
  await act(async () => { root.render(<QueryClientProvider client={client}><AgentConversationsSidebar compact={compact} onConversationOpened={onConversationOpened} /></QueryClientProvider>); });
}
async function addChat() { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add chat"]')!.click()); }
async function choose(name: string) { await act(async () => [...document.querySelectorAll<HTMLElement>("[role=option]")].find(option => option.textContent?.startsWith(name))!.click()); }
async function openContact(name: string) {
  await act(async () => container.querySelector<HTMLAnchorElement>(`a[href="/chats/${name}"]`)!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.companyId = "company-a";
  state.navigate.mockReset(); state.closeSidebar.mockReset(); state.ensure.mockReset(); state.getAgent.mockReset(); state.newAgent.mockReset(); issueUpdates.mockClear(); localStorage.clear(); sessionStorage.clear();
  sidebarInputs.length = 0;
  state.ensure.mockImplementation(async (_company, id) => chat(id));
  memberships.agentMemberships = {};
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
  client.setQueryData(queryKeys.agents.list("company-a"), roster);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("alice")]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
it("notifies its parent only after a chat opens successfully", async () => {
  const opened = vi.fn();
  state.ensure.mockRejectedValueOnce(new Error("Couldn’t open chat"));
  await render(opened); await addChat(); await choose("bob");
  expect(opened).not.toHaveBeenCalled();
  await choose("bob");
  expect(opened).toHaveBeenCalledOnce();
});
function commitChatWithLostFirstResponse() {
  const committed = new Map<string, ReturnType<typeof chat>>();
  let loseResponse = true;
  state.ensure.mockImplementation(async (companyId: string, agentId: string, requestId?: string) => {
    const userId = client.getQueryData<{ user: { id: string } }>(queryKeys.auth.session)!.user.id;
    const key = `${companyId}:${userId}:${agentId}:${requestId ?? crypto.randomUUID()}`;
    const conversation = committed.get(key) ?? { ...chat(agentId), id: `chat-${crypto.randomUUID()}`, companyId, conversationUserId: userId };
    committed.set(key, conversation);
    if (loseResponse) { loseResponse = false; throw new TypeError("Connection lost after the chat was created"); }
    return conversation;
  });
  return committed;
}
it.each([false, true])("retries a lost create response without another chat (remount=%s)", async remount => {
  const committed = commitChatWithLostFirstResponse();
  await render(); await addChat(); await choose("bob");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Connection lost");
  expect(state.navigate).not.toHaveBeenCalled();
  if (remount) {
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(); await addChat();
  }
  await choose("bob");
  expect(committed.size).toBe(1);
  const requestId = state.ensure.mock.calls[0][2];
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(state.ensure.mock.calls[1][2]).toBe(requestId);
  const [conversation] = committed.values();
  expect(state.navigate).toHaveBeenLastCalledWith(`/chats/bob/${conversation.id}`);
  expect(client.getQueryData<ReturnType<typeof chat>[]>(queryKeys.agentChats.list("company-a", "user-a"))!.filter(item => item.conversationAgentId === "bob")).toHaveLength(1);
});
it("starts a new chat on a plain-HTTP page, where the browser has no randomUUID", async () => {
  const { randomUUID: _secureContextOnly, ...insecure } = { randomUUID: undefined, getRandomValues: crypto.getRandomValues.bind(crypto) };
  vi.stubGlobal("crypto", insecure);
  await render(); await addChat(); await choose("bob");
  expect(state.ensure).toHaveBeenCalledTimes(1);
  expect(state.ensure.mock.calls[0][2]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});
it("uses a fresh request for a new chat after confirmed creation", async () => {
  state.ensure.mockImplementation(async (companyId: string, agentId: string) => ({ ...chat(agentId), companyId, id: crypto.randomUUID() }));
  await render(); await addChat(); await choose("bob");
  await addChat(); await choose("bob");
  expect(state.ensure.mock.calls[0][2]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(state.ensure.mock.calls[1][2]).not.toBe(state.ensure.mock.calls[0][2]);
  expect(client.getQueryData<ReturnType<typeof chat>[]>(queryKeys.agentChats.list("company-a", "user-a"))!.filter(item => item.conversationAgentId === "bob")).toHaveLength(2);
});
it("starts a fresh request after the server definitively rejects creation", async () => {
  state.ensure.mockRejectedValueOnce(new ApiError("Not allowed", 403, null));
  await render(); await addChat(); await choose("bob");
  await choose("bob");
  expect(state.ensure.mock.calls[1][2]).not.toBe(state.ensure.mock.calls[0][2]);
});
it.each([408, 429, 503])("retains the pending request after HTTP %s", async status => {
  state.ensure.mockRejectedValueOnce(new ApiError("Try again", status, null));
  await render(); await addChat(); await choose("bob");
  await choose("bob");
  expect(state.ensure.mock.calls[1][2]).toBe(state.ensure.mock.calls[0][2]);
});
it.each(["company", "user", "agent"])("keeps pending create retries in their original %s scope", async changed => {
  commitChatWithLostFirstResponse();
  await render(); await addChat(); await choose("bob");
  if (changed === "company") {
    state.companyId = "company-b";
    client.setQueryData(queryKeys.agents.list("company-b"), roster.map(agent => ({ ...agent, companyId: "company-b" })));
    client.setQueryData(queryKeys.agentChats.list("company-b", "user-a"), []);
    await render(); await addChat(); await choose("bob");
    state.companyId = "company-a";
    await render();
  } else if (changed === "user") {
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-b" } });
    client.setQueryData(queryKeys.agentChats.list("company-a", "user-b"), []);
    await render(); await addChat(); await choose("bob");
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
    await render();
  } else {
    await choose("alice");
  }
  expect(state.ensure.mock.calls[1][2]).not.toBe(state.ensure.mock.calls[0][2]);
  await addChat(); await choose("bob");
  expect(state.ensure.mock.calls[2][2]).toBe(state.ensure.mock.calls[0][2]);
});
it("does not send a create when its retry intent cannot be saved to browser storage", async () => {
  const original = Storage.prototype.setItem;
  const store = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function(this: Storage, key, value) {
    if (key.startsWith("agent-chat-create:")) throw new DOMException("Storage full", "QuotaExceededError");
    return original.call(this, key, value);
  });
  try {
    await render(); await addChat(); await choose("bob");
    expect(state.ensure).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("save the chat request");
  } finally { store.mockRestore(); }
});
it("waits for the current account before binding a new chat request", async () => {
  const rejected = vi.fn();
  function Select({ userId }: { userId: string | null }) {
    const open = useOpenAgentChat("company-a", userId, true);
    return <button onClick={() => { void open(roster[1]).catch(rejected); }}>Create</button>;
  }
  const show = async (userId: string | null) => {
    await act(async () => root.render(<QueryClientProvider client={client}><Select userId={userId} /></QueryClientProvider>));
  };
  const select = async () => { await act(async () => container.querySelector<HTMLButtonElement>("button")!.click()); };
  client.removeQueries({ queryKey: queryKeys.auth.session });
  await show(null); await select();
  expect(state.ensure).not.toHaveBeenCalled();
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
  await select();
  expect(state.ensure).not.toHaveBeenCalled();
  expect(rejected).toHaveBeenCalledTimes(2);
  await show("user-a"); await select();
  expect(state.ensure).toHaveBeenCalledExactlyOnceWith("company-a", "bob", expect.any(String));
});
it("creates a chat and lists it separately from the agent", async () => {
  await render();
  expect(container.querySelectorAll('nav[aria-label="Agent conversations"] a')).toHaveLength(2);
  await addChat();
  expect([...document.querySelectorAll("[role=option]")].find(option => option.textContent?.startsWith("bob"))?.textContent).toContain("New chat");
  await choose("bob");
  expect(state.ensure).toHaveBeenCalledWith("company-a", "bob", expect.stringMatching(/^[0-9a-f-]{36}$/i));
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob/chat-bob");
  expect(state.closeSidebar).toHaveBeenCalledWith(false);
  await render();
  expect(container.querySelector('a[href="/chats/bob/chat-bob"]')).not.toBeNull();
  await addChat();
  expect([...document.querySelectorAll("[role=option]")].find(option => option.textContent?.startsWith("bob"))?.textContent).toContain("New chat");
  await choose("bob"); await render();
  expect(container.querySelectorAll('a[href="/chats/bob/chat-bob"]')).toHaveLength(1);
  expect(client.getQueryData(queryKeys.agentChats.list("company-a", "user-a"))).toHaveLength(2);
});
it("keeps failures retryable in the picker and closes it on company changes", async () => {
  state.ensure.mockRejectedValueOnce(new Error("Couldn’t open chat. Try again."));
  await render(); await addChat(); await choose("bob");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t open chat");
  expect(state.navigate).not.toHaveBeenCalled();
  await choose("bob");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob/chat-bob");
  await addChat();
  state.companyId = "company-b";
  client.setQueryData(queryKeys.agents.list("company-b"), []);
  client.setQueryData(queryKeys.agentChats.list("company-b", "user-a"), []);
  await render();
  expect(document.querySelector('[role="option"]')).toBeNull();
});
it("opens every contact without creating a conversation before the first message", async () => {
  await render();
  expect(container.querySelectorAll('nav[aria-label="Agent conversations"] a')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Add chat"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Search chats"]')).not.toBeNull();
  await openContact("bob");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob");
  expect(state.closeSidebar).toHaveBeenCalledWith(false);
  expect(state.ensure).not.toHaveBeenCalled();
  await openContact("alice");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/alice");
  expect(container.querySelectorAll('a[href="/chats/bob"]')).toHaveLength(1);
});
const pinStorageKey = "paperclip.coordinator.pinned-nav.v1:user-a";
const contactOrder = () => [...container.querySelectorAll('nav[aria-label="Agent conversations"] a')].map(link => link.getAttribute("href"));

it("lists and opens separate chats for the same agent", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [
    { ...chat("alice"), id: "first", title: "First chat", createdAt: "2026-09-01T12:00:00Z" },
    { ...chat("alice"), id: "second", title: "Second chat", createdAt: "2026-09-02T12:00:00Z" },
  ]);
  await render();
  const history = container.querySelector('nav[aria-label="Chat history"]')!;
  expect(history.querySelector('a[href="/chats/alice/first"]')?.textContent).toContain("First chat");
  expect(history.querySelector('a[href="/chats/alice/second"]')?.textContent).toContain("Second chat");
  await act(async () => history.querySelector<HTMLAnchorElement>('a[href="/chats/alice/second"]')!.click());
  expect(state.closeSidebar).toHaveBeenCalledWith(false);
});

it("renames a chat inline from the history", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [{ ...chat("alice"), id: "first", title: "How do I reset my password?", createdAt: "2026-09-01T12:00:00Z" }]);
  await render();
  const history = container.querySelector('nav[aria-label="Chat history"]')!;
  await act(async () => history.querySelector<HTMLButtonElement>('button[aria-label="Rename How do I reset my password?"]')!.click());
  const input = history.querySelector<HTMLInputElement>('input[aria-label="Chat title"]')!;
  // Touch devices keep the shared 16px input size, so Safari does not zoom on focus.
  expect(input.className.split(" ")).toContain("text-base");
  // Touch devices keep the shared 16px input size, so Safari does not zoom on focus.
  expect(input.className.split(/s+/)).not.toContain("text-sm");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Password help");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => input.form!.requestSubmit());
  expect(issueUpdates).toHaveBeenCalledWith("first", { title: "Password help" });
  expect(history.querySelector('input[aria-label="Chat title"]')).toBeNull();
});

it("confirms an unchanged provisional chat title with Enter, but not by leaving the field", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [{ ...chat("alice"), id: "first", title: "Plan the Q3 offsite", titleNeedsGeneration: true, createdAt: "2026-09-01T12:00:00Z" }]);
  await render();
  const history = container.querySelector('nav[aria-label="Chat history"]')!;
  const open = async () => act(async () => history.querySelector<HTMLButtonElement>('button[aria-label="Rename Plan the Q3 offsite"]')!.click());
  await open();
  await act(async () => history.querySelector<HTMLInputElement>('input[aria-label="Chat title"]')!.blur());
  expect(issueUpdates).not.toHaveBeenCalled();
  await open();
  await act(async () => history.querySelector<HTMLInputElement>('input[aria-label="Chat title"]')!.form!.requestSubmit());
  expect(issueUpdates).toHaveBeenCalledWith("first", { title: "Plan the Q3 offsite" });
});

it("retains terminated agents' history by id without offering them for new chats", async () => {
  const retired = { ...roster[0], id: "retired-id", name: "Retired", status: "terminated", urlKey: "alice" };
  client.setQueryData(queryKeys.agents.detail(retired.id), retired);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat(retired.id), chat("alice")]);
  await render();
  const historyLink = container.querySelector<HTMLAnchorElement>('a[href="/chats/retired-id"]')!;
  expect(historyLink.textContent).toContain("RetiredTerminated");
  await act(async () => historyLink.click());
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/retired-id");
  await addChat();
  expect([...document.querySelectorAll("[role=option]")].some(option => option.textContent?.includes("Retired"))).toBe(false);
});

it("opens a confirmed new chat when the picker was dismissed while it was being created", async () => {
  let finishAlice!: (value: ReturnType<typeof chat>) => void;
  state.ensure.mockImplementation(async (_company, id) => id === "alice"
    ? new Promise(resolve => { finishAlice = resolve; }) : chat(id));
  const opened = vi.fn();
  await render(opened); await addChat(); await choose("alice");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click());
  expect(state.navigate).not.toHaveBeenCalled();
  expect(opened).not.toHaveBeenCalled();
  await act(async () => finishAlice(chat("alice")));
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/alice/chat-alice");
  // The surrounding history closes with the confirmed chat, as it does for a picker that stayed open.
  expect(opened).toHaveBeenCalledOnce();
});
it("does not let a chat dismissed in one picker replace a newer chat from the other picker", async () => {
  let finishAlice!: (value: ReturnType<typeof chat>) => void;
  state.ensure.mockImplementation(async (_company, id) => id === "alice"
    ? new Promise(resolve => { finishAlice = resolve; }) : chat(id));
  // The Coordinator's New chat picker is a separate hook instance from the history's Add chat picker.
  function CoordinatorNewChat() {
    const openNewChat = useOpenAgentChat("company-a", "user-a", true);
    return <button type="button" onClick={() => { void openNewChat(roster[1]!); }}>Coordinator new chat with bob</button>;
  }
  await act(async () => { root.render(<QueryClientProvider client={client}><AgentConversationsSidebar /><CoordinatorNewChat /></QueryClientProvider>); });
  await addChat(); await choose("alice");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click());
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Coordinator new chat with bob")!.click());
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob/chat-bob");
  await act(async () => finishAlice(chat("alice")));
  expect(state.navigate).toHaveBeenCalledTimes(1);
});
it("does not let a dismissed selection override a newer chat", async () => {
  let finishAlice!: (value: ReturnType<typeof chat>) => void;
  state.ensure.mockImplementation(async (_company, id) => id === "alice"
    ? new Promise(resolve => { finishAlice = resolve; }) : chat(id));
  await render(); await addChat(); await choose("alice");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click());
  await addChat(); await choose("bob");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob/chat-bob");
  await act(async () => finishAlice(chat("alice")));
  expect(state.navigate).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(queryKeys.agentChats.list("company-a", "user-a"))).toHaveLength(2);
});

it("combines unread counts across separate conversations for the same contact", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [
    { ...chat("alice"), id: "first", title: "First", unreadMessageCount: 2 },
    { ...chat("alice"), id: "second", title: "Second", unreadMessageCount: 3 },
  ]);
  await render();
  expect(container.querySelectorAll('nav[aria-label="Agent conversations"] a[href="/chats/alice"]')).toHaveLength(1);
  expect(container.querySelector('[aria-label="5 unread messages from alice"]')).not.toBeNull();
  expect(container.querySelectorAll('nav[aria-label="Chat history"] a')).toHaveLength(2);
});

it("marks the unread conversation and keeps its link separate from the default contact", async () => {
  const key = queryKeys.agentChats.list("company-a", "user-a");
  const first = { ...chat("alice"), id: "first", title: "First discussion", unreadMessageCount: 2, isUnreadForMe: true };
  const second = { ...chat("alice"), id: "second", title: "Second discussion", unreadMessageCount: 1, isUnreadForMe: true };
  client.setQueryData(key, [first, second]);
  await render();
  const history = container.querySelector('nav[aria-label="Chat history"]')!;
  expect(history.querySelector('a[href="/chats/alice/first"] [aria-label="2 unread messages in First discussion"]')).not.toBeNull();
  expect(history.querySelector('a[href="/chats/alice/second"] [aria-label="1 unread message in Second discussion"]')).not.toBeNull();
  await act(async () => { client.setQueryData(key, [{ ...first, unreadMessageCount: 0, isUnreadForMe: false }, second]); });
  await vi.waitFor(() => expect(history.querySelector('[aria-label="2 unread messages in First discussion"]')).toBeNull());
  expect(history.querySelector('[aria-label="1 unread message in Second discussion"]')).not.toBeNull();
});

it("lists and filters hundreds of conversations with hundreds of agents in linear work", async () => {
  // A history row per saved conversation: an agent lookup that scans the roster per chat would read agent ids
  // agents x chats times. Count every read and stop a runaway render at the budget.
  const agentCount = 500;
  const readBudget = 50 * agentCount;
  let idReads = 0;
  const agents = Array.from({ length: agentCount }, (_, index) => {
    const id = `agent-${index}`;
    return Object.defineProperty({ companyId: "company-a", name: `Agent ${index}`, urlKey: `agent-${index}`, role: "general", title: "Teammate", status: "idle" },
      "id", { enumerable: true, get: () => {
        if (++idReads > readBudget) throw new Error(`The chat sidebar read agent ids ${idReads} times`);
        return id;
      } }) as unknown as Agent;
  });
  const chats = Array.from({ length: agentCount }, (_, index) => ({ ...chat(`agent-${agentCount - 1 - index}`),
    id: `history-${index}`, title: `Topic ${index}`, conversationDefault: index % 2 === 0 }));
  client.setQueryData(queryKeys.agents.list("company-a"), agents);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), chats);
  await render();
  const history = () => container.querySelector('nav[aria-label="Chat history"]')!;
  expect(history().querySelectorAll("a")).toHaveLength(agentCount);
  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search chats"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "Topic 49");
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // Topic 49 and Topic 490-499.
  expect(history().querySelectorAll("a")).toHaveLength(11);
  expect(idReads).toBeLessThanOrEqual(readBudget);
}, 30_000);
