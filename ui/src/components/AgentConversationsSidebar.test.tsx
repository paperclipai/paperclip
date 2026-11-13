// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentConversationsSidebar } from "./AgentConversationsSidebar";
import type { AgentConversationSidebarProps } from "./AgentConversationSidebar";
import { queryKeys } from "@/lib/queryKeys";
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
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { list: vi.fn(), ensure: state.ensure } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: () => ({ user: { id: "user-a" } }) } }));
vi.mock("@/api/departments", () => ({ departmentsApi: { list: vi.fn(async () => []) } }));
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
async function openContact(name: string) {
  await act(async () => container.querySelector<HTMLAnchorElement>(`a[href="/chats/${name}"]`)!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.companyId = "company-a";
  state.navigate.mockReset(); state.closeSidebar.mockReset(); state.ensure.mockReset(); state.getAgent.mockReset(); state.newAgent.mockReset(); localStorage.clear();
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
it("opens every contact without creating a conversation before the first message", async () => {
  await render();
  expect(container.querySelectorAll('nav[aria-label="Agent conversations"] a')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Add chat"]')).toBeNull();
  expect(container.querySelector('[aria-label="Search chats"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Chat list layout"]')).toBeNull();
  await openContact("bob");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/bob");
  expect(state.closeSidebar).toHaveBeenCalledWith(false);
  expect(state.ensure).not.toHaveBeenCalled();
  await openContact("alice");
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/alice");
  expect(container.querySelectorAll('a[href="/chats/bob"]')).toHaveLength(1);
});
it("opens the existing create-agent dialog and persists a company-scoped chat pin", async () => {
  await render();
  await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Create a new agent")!.click());
  expect(state.newAgent).toHaveBeenCalledOnce();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Pin bob"]')!.click());
  expect(JSON.parse(localStorage.getItem("paperclip.coordinator.pinned-nav.v1:user-a")!)).toEqual(["agent-chat:company-a:bob"]);
  expect(container.querySelector('[aria-label="Unpin bob"]')?.getAttribute("aria-pressed")).toBe("true");
  expect(contactOrder()).toEqual(["/chats/bob", "/chats/alice"]);
  expect(state.ensure).not.toHaveBeenCalled();
});
const pinStorageKey = "paperclip.coordinator.pinned-nav.v1:user-a";
const contactOrder = () => [...container.querySelectorAll('nav[aria-label="Agent conversations"] a')].map(link => link.getAttribute("href"));

it.each([false, true])("keeps the pin button mounted and focused when toggling a contact with pinned=%s", async pinned => {
  if (pinned) localStorage.setItem(pinStorageKey, JSON.stringify(["agent-chat:company-a:bob"]));
  await render();
  const button = container.querySelector<HTMLButtonElement>(`[aria-label="${pinned ? "Unpin" : "Pin"} bob"]`)!;
  await act(async () => { button.focus(); button.click(); });
  expect(button.isConnected).toBe(true);
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-label")).toBe(`${pinned ? "Pin" : "Unpin"} bob`);
  expect(contactOrder()).toEqual(pinned ? ["/chats/alice", "/chats/bob"] : ["/chats/bob", "/chats/alice"]);
});

it("puts pins first in saved order ahead of active and recent chats, and restores recency when unpinned", async () => {
  const carol = { ...roster[0], id: "carol", name: "carol", urlKey: "carol" };
  client.setQueryData(queryKeys.agents.list("company-a"), [...roster, carol]);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("alice"), chat("bob")]);
  localStorage.setItem(pinStorageKey, JSON.stringify(["agent-chat:other-company:alice", "agent-chat:company-a:carol", "/artifacts", "agent-chat:company-a:bob", "agent-chat:company-a:missing"]));
  await render();
  expect(contactOrder()).toEqual(["/chats/carol", "/chats/bob", "/chats/alice"]);
  expect(container.querySelector('[aria-label="Reorder pinned carol"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Reorder pinned alice"]')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Unpin bob"]')!.click());
  expect(contactOrder()).toEqual(["/chats/carol", "/chats/alice", "/chats/bob"]);
  expect(JSON.parse(localStorage.getItem(pinStorageKey)!)).toContain("agent-chat:other-company:alice");
});

it("groups chat contacts into collapsible department stacks and keeps the linear list otherwise", async () => {
  const carol = { ...roster[0], id: "carol", name: "carol", urlKey: "carol" };
  client.setQueryData(queryKeys.agents.list("company-a"), [...roster, carol]);
  client.setQueryData(queryKeys.departments.list("company-a"), [
    { id: "dept-research", companyId: "company-a", name: "Research", agentIds: ["alice", "bob"] },
    { id: "dept-design", companyId: "company-a", name: "Design", agentIds: ["alice"] },
    { id: "dept-empty", companyId: "company-a", name: "Empty", agentIds: [] },
  ]);
  await render();
  expect(container.querySelector('[aria-label="Chat list layout"]')).not.toBeNull();
  expect(container.querySelector('select[aria-label="Department"]')).toBeNull();
  expect(contactOrder()).toEqual(["/chats/alice", "/chats/bob", "/chats/carol"]);
  expect(container.textContent).not.toContain("Design");
  const press = (label: string) => [...container.querySelectorAll("button")].find(button => button.textContent === label)!;
  await act(async () => press("By department").click());
  expect(press("By department").getAttribute("aria-pressed")).toBe("true");
  expect(contactOrder()).toEqual(["/chats/alice", "/chats/alice", "/chats/bob", "/chats/carol"]);
  expect(container.textContent).not.toContain("Empty");
  const stack = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(button => button.textContent?.includes(name))!;
  expect(stack("Design").getAttribute("aria-expanded")).toBe("true");
  expect(stack("No department").getAttribute("aria-expanded")).toBe("true");
  await act(async () => stack("Design").click());
  expect(stack("Design").getAttribute("aria-expanded")).toBe("false");
  expect(contactOrder()).toEqual(["/chats/alice", "/chats/bob", "/chats/carol"]);
  await act(async () => stack("Design").click());
  expect(contactOrder()).toEqual(["/chats/alice", "/chats/alice", "/chats/bob", "/chats/carol"]);
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search chats"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "carol");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(contactOrder()).toEqual(["/chats/carol"]);
  expect(container.textContent).not.toContain("Design");
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search chats"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    press("List").click();
  });
  expect(contactOrder()).toEqual(["/chats/alice", "/chats/bob", "/chats/carol"]);
  expect(container.querySelector("button[aria-expanded]")).toBeNull();
});

it("reorders filtered pins with the keyboard and saves their order without moving hidden pins", async () => {
  const agents = ["alice", "bob", "carol", "dave"].map(id => ({ ...roster[0], id, name: id, urlKey: id, title: id === "alice" || id === "carol" ? "Designer" : "Engineer" }));
  client.setQueryData(queryKeys.agents.list("company-a"), agents);
  const saved = ["agent-chat:company-a:alice", "agent-chat:other-company:hidden", "agent-chat:company-a:bob", "/artifacts", "agent-chat:company-a:carol"];
  localStorage.setItem(pinStorageKey, JSON.stringify(saved));
  await render();
  await act(async () => {
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search chats"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Designer");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const rows = [...container.querySelectorAll(".agent-contact-pin-row")];
    const top = Math.max(0, rows.indexOf(this)) * 80;
    return { x: 0, y: top, top, bottom: top + 80, left: 0, right: 240, width: 240, height: 80, toJSON() {} };
  });
  const key = async (target: Element, code: string) => {
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { code, key: code === "Space" ? " " : code, bubbles: true, cancelable: true }));
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  };
  try {
    const handle = container.querySelector<HTMLButtonElement>('[aria-label="Reorder pinned alice"]');
    expect(handle).not.toBeNull();
    handle!.focus();
    await key(handle!, "Space");
    await key(handle!, "ArrowDown");
    await key(handle!, "Space");
    expect(contactOrder()).toEqual(["/chats/carol", "/chats/alice"]);
    expect(JSON.parse(localStorage.getItem(pinStorageKey)!)).toEqual([saved[4], ...saved.slice(1, 4), saved[0]]);
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.ensure).not.toHaveBeenCalled();
    await act(async () => root.unmount()); root = createRoot(container);
    await render();
    expect(contactOrder()).toEqual(["/chats/carol", "/chats/bob", "/chats/alice", "/chats/dave"]);
  } finally { rect.mockRestore(); }
});
it("replaces contacts when the company changes", async () => {
  await render();
  state.companyId = "company-b";
  client.setQueryData(queryKeys.agents.list("company-b"), []);
  client.setQueryData(queryKeys.agentChats.list("company-b", "user-a"), []);
  await render();
  expect(container.textContent).not.toContain("alice");
  expect(container.textContent).not.toContain("bob");
});

it("preserves recent activity order when reopening an older conversation", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("bob"), chat("alice")]);
  await render();
  const links = () => [...container.querySelectorAll('nav[aria-label="Agent conversations"] a')].map(link => link.getAttribute("href"));
  expect(links()).toEqual(["/chats/bob", "/chats/alice"]);
  await openContact("alice"); await render();
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

it("passes numeric unread counts to contacts and updates them from the account cache", async () => {
  const key = queryKeys.agentChats.list("company-a", "user-a");
  client.setQueryData(key, [{ ...chat("alice"), isUnreadForMe: true, unreadMessageCount: 8 }, chat("bob")]);
  await render();
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
  const savedPins = JSON.stringify(agents.map(agent => `agent-chat:company-a:${agent.id}`).reverse());
  localStorage.setItem("paperclip.coordinator.pinned-nav.v1:user-a", savedPins);
  const originalParse = JSON.parse;
  let pinParses = 0;
  const parse = vi.spyOn(JSON, "parse").mockImplementation((value, reviver) => {
    if (value === savedPins && ++pinParses > 8) throw new Error("Each contact parses the full pin list");
    return originalParse(value, reviver);
  });
  try {
    const chats = agents.map(agent => ({ ...chat(agent.id), isUnreadForMe: true, unreadMessageCount: 7 }));
    const key = queryKeys.agentChats.list("company-a", "user-a");
    client.setQueryData(queryKeys.agents.list("company-a"), agents);
    client.setQueryData(key, chats);
    await render();
    const first = sidebarInputs.at(-1)!;
    expect(first.existingChatAgentIds).toHaveLength(500);
    expect(first.unreadAgentIds).toHaveLength(500);
    expect(document.querySelectorAll('[aria-label^="7 unread messages from"]')).toHaveLength(500);
    expect(contactOrder()[0]).toBe("/chats/agent-499");
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
    expect(container.querySelectorAll('[aria-label^="Unpin Agent "]')).toHaveLength(500);
    expect(pinParses).toBeLessThanOrEqual(8);
  } finally { parse.mockRestore(); }
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
  expect(state.ensure).not.toHaveBeenCalled();
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
    const input = container.querySelector<HTMLInputElement>('[aria-label="Search chats"]')!;
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
