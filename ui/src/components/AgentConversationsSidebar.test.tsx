// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentConversationsSidebar } from "./AgentConversationsSidebar";
import type { AgentConversationSidebarProps } from "./AgentConversationSidebar";
import { queryKeys } from "@/lib/queryKeys";
const state = vi.hoisted(() => ({ companyId: "company-a", navigate: vi.fn(), closeSidebar: vi.fn(), ensure: vi.fn(), getAgent: vi.fn() }));
const sidebarInputs = vi.hoisted(() => [] as Pick<AgentConversationSidebarProps, "existingChatAgentIds" | "unreadAgentIds" | "unreadMessageCounts">[]);
vi.mock("./AgentConversationSidebar", async importOriginal => {
  const original = await importOriginal<typeof import("./AgentConversationSidebar")>();
  return { AgentConversationSidebar: (props: AgentConversationSidebarProps) => {
    sidebarInputs.push({ existingChatAgentIds: props.existingChatAgentIds, unreadAgentIds: props.unreadAgentIds, unreadMessageCounts: props.unreadMessageCounts });
    return <original.AgentConversationSidebar {...props} />;
  } };
});
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: true, setSidebarOpen: state.closeSidebar }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/A/chats/alice" }), useNavigate: () => state.navigate,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: vi.fn(), get: state.getAgent } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { list: vi.fn(), ensure: state.ensure } }));
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
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><AgentConversationsSidebar /></QueryClientProvider>); });
}
async function addChat() { await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add chat"]')!.click()); }
async function choose(name: string) {
  await act(async () => [...document.querySelectorAll<HTMLElement>("[role=option]")].find(option => option.textContent?.startsWith(name))!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.companyId = "company-a";
  sidebarInputs.length = 0;
  state.navigate.mockReset(); state.closeSidebar.mockReset(); state.ensure.mockReset(); state.getAgent.mockReset();
  state.ensure.mockImplementation(async (_company, id) => chat(id));
  memberships.agentMemberships = {};
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
  client.setQueryData(queryKeys.agents.list("company-a"), roster);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("alice")]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
it("adds through the server and reopens one cached conversation without a duplicate row", async () => {
  await render();
  expect(container.querySelectorAll('nav[aria-label="Agent conversations"] a')).toHaveLength(2);
  await addChat();
  expect([...document.querySelectorAll("[role=option]")].find(option => option.textContent?.startsWith("bob"))?.textContent).not.toContain("Open chat");
  await choose("bob");
  expect(state.ensure).toHaveBeenCalledWith("company-a", "bob");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob");
  expect(state.closeSidebar).toHaveBeenCalledWith(false);
  await render();
  expect(client.getQueryData(queryKeys.agentChats.detail("company-a", "user-a", "bob"))).toEqual(chat("bob"));
  await addChat();
  expect([...document.querySelectorAll("[role=option]")].find(option => option.textContent?.startsWith("bob"))?.textContent).toContain("Open chat");
  await choose("bob"); await render();
  expect(container.querySelectorAll('a[href="/chats/bob"]')).toHaveLength(1);
  expect(client.getQueryData(queryKeys.agentChats.list("company-a", "user-a"))).toHaveLength(2);
});
it("keeps failures retryable in the picker and closes it on company changes", async () => {
  state.ensure.mockRejectedValueOnce(new Error("Couldn’t open chat. Try again."));
  await render(); await addChat(); await choose("bob");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t open chat");
  expect(state.navigate).not.toHaveBeenCalled();
  await choose("bob");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob");
  await addChat();
  state.companyId = "company-b";
  client.setQueryData(queryKeys.agents.list("company-b"), []);
  client.setQueryData(queryKeys.agentChats.list("company-b", "user-a"), []);
  await render();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(container.textContent).not.toContain("alice");
});

it("preserves recent activity order when reopening an older conversation", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("bob"), chat("alice")]);
  await render();
  const links = () => [...container.querySelectorAll('nav[aria-label="Agent conversations"] a')].map(link => link.getAttribute("href"));
  expect(links()).toEqual(["/chats/bob", "/chats/alice"]);
  await addChat(); await choose("alice"); await render();
  expect(links()).toEqual(["/chats/bob", "/chats/alice"]);
});

it("shows accessible unread indicators only for the current company and human", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [{ ...chat("alice"), isUnreadForMe: true }, chat("bob")]);
  client.setQueryData(queryKeys.agentChats.list("company-a", "other-human"), [{ ...chat("bob"), isUnreadForMe: true }]);
  await render();
  expect(container.querySelector('[aria-label="Unread messages from alice"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Unread messages from bob"]')).toBeNull();
  state.companyId = "company-b";
  client.setQueryData(queryKeys.agents.list("company-b"), []);
  client.setQueryData(queryKeys.agentChats.list("company-b", "user-a"), []);
  await render();
  expect(container.querySelector('[aria-label^="Unread messages"]')).toBeNull();
});

it("passes numeric unread counts to Add chat and updates them from the account cache", async () => {
  const key = queryKeys.agentChats.list("company-a", "user-a");
  client.setQueryData(key, [{ ...chat("alice"), isUnreadForMe: true, unreadMessageCount: 8 }, chat("bob")]);
  await render(); await addChat();
  expect(document.querySelector('[aria-label="8 unread messages from alice"]')?.textContent).toBe("8");
  expect(document.querySelector('[aria-label*="unread message from bob"]')).toBeNull();
  await act(async () => {
    client.setQueryData(key, [{ ...chat("alice"), isUnreadForMe: true, unreadMessageCount: 1 }]);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[aria-label="1 unread message from alice"]')?.textContent).toBe("1");
  await act(async () => {
    client.setQueryData(key, [{ ...chat("alice"), isUnreadForMe: false, unreadMessageCount: 0 }]);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[aria-label*="unread message"]')).toBeNull();
});

it("reuses chat indexes for 500 agents across unchanged parent renders and refreshes changed counts", async () => {
  const agents = Array.from({ length: 500 }, (_, index) => ({ ...roster[0], id: `agent-${index}`, name: `Agent ${index}`, urlKey: `agent-${index}` }));
  const chats = agents.map(agent => ({ ...chat(agent.id), isUnreadForMe: true, unreadMessageCount: 7 }));
  const key = queryKeys.agentChats.list("company-a", "user-a");
  client.setQueryData(queryKeys.agents.list("company-a"), agents);
  client.setQueryData(key, chats);
  await render(); await addChat();
  const first = sidebarInputs.at(-1)!;
  expect(first.existingChatAgentIds).toHaveLength(500);
  expect(first.unreadAgentIds).toHaveLength(500);
  expect(document.querySelectorAll('[aria-label^="7 unread messages from"]')).toHaveLength(500);
  await render();
  const unchanged = sidebarInputs.at(-1)!;
  expect(unchanged.existingChatAgentIds).toBe(first.existingChatAgentIds);
  expect(unchanged.unreadAgentIds).toBe(first.unreadAgentIds);
  expect(unchanged.unreadMessageCounts).toBe(first.unreadMessageCounts);
  await act(async () => {
    client.setQueryData(key, [{ ...chats[0], isUnreadForMe: false, unreadMessageCount: 0 }, ...chats.slice(1)]);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[aria-label="7 unread messages from Agent 0"]')).toBeNull();
  expect(document.querySelectorAll('[aria-label^="7 unread messages from"]')).toHaveLength(499);
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

it("does not let a dismissed selection override a newer chat", async () => {
  let finishAlice!: (value: ReturnType<typeof chat>) => void;
  state.ensure.mockImplementation(async (_company, id) => id === "alice"
    ? new Promise(resolve => { finishAlice = resolve; }) : chat(id));
  await render(); await addChat(); await choose("alice");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"]')!.click());
  await addChat(); await choose("bob");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob");
  await act(async () => finishAlice(chat("alice")));
  expect(state.navigate).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(queryKeys.agentChats.list("company-a", "user-a"))).toHaveLength(2);
});

it("keeps healthy chats usable while a historical lookup fails and retries", async () => {
  const retired = { ...roster[0], id: "retired-id", name: "Retired", status: "terminated" };
  state.getAgent.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(retired);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat(retired.id), chat("alice")]);
  await render();
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Some chat history couldn’t load");
  });
  expect(container.querySelector('a[href="/chats/alice"]')).not.toBeNull();
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search agents"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "No match");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(container.textContent).toContain("No agents found");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click());
  expect(container.querySelector('a[href="/chats/alice"]')).not.toBeNull();
  await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry chat history")!.click());
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(container.querySelector('a[href="/chats/retired-id"]')).not.toBeNull();
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('a[href="/chats/alice"]')).not.toBeNull();
});

it("lists every eligible agent: open chat, then conversations by recency, then the rest alphabetically", async () => {
  const more = [
    { ...roster[0], id: "zed", name: "Zed", urlKey: "zed" },
    { ...roster[0], id: "carol", name: "carol", urlKey: "carol" },
    { ...roster[0], id: "gone", name: "Gone", urlKey: "gone", status: "terminated" },
    { ...roster[0], id: "left", name: "Left", urlKey: "left" },
  ] as Agent[];
  memberships.agentMemberships = { left: "left" };
  client.setQueryData(queryKeys.agents.list("company-a"), [...more, ...roster]);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("bob")]);
  await render();
  await vi.waitFor(async () => {
    await act(async () => {});
    expect([...container.querySelectorAll('nav[aria-label="Agent conversations"] a')].map(link => link.getAttribute("href")))
      .toEqual(["/chats/alice", "/chats/bob", "/chats/carol", "/chats/zed"]); // the open chat (alice) is pinned first
  });
});
