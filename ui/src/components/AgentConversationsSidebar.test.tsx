// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { AgentConversationsSidebar } from "./AgentConversationsSidebar";
import type { AgentConversationSidebarProps } from "./AgentConversationSidebar";
import { queryKeys } from "@/lib/queryKeys";
const state = vi.hoisted(() => ({ companyId: "company-a", pathname: "/A/chats/alice", navigate: vi.fn(), closeSidebar: vi.fn(), ensure: vi.fn(), getAgent: vi.fn(), newAgent: vi.fn(), terminate: vi.fn(), pushToast: vi.fn(), listAgents: vi.fn(), listChats: vi.fn() }));
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
  useLocation: () => ({ pathname: state.pathname }), useNavigate: () => state.navigate,
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));
vi.mock("@/api/agents", () => ({ agentsApi: { list: state.listAgents, get: state.getAgent, terminate: state.terminate } }));
vi.mock("@/api/access", () => ({ accessApi: { getCurrentBoardAccess: vi.fn() } }));
vi.mock("@/api/instanceSettings", () => ({ instanceSettingsApi: { getExperimental: vi.fn() } }));
vi.mock("@/api/builtInAgents", () => ({ builtInAgentsApi: { list: vi.fn() } }));
vi.mock("@/context/ToastContext", () => ({ useToastActions: () => ({ pushToast: state.pushToast }) }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { list: state.listChats, ensure: state.ensure } }));
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
const boardAccess = (membershipRole: string) => ({ userId: "user-a", isInstanceAdmin: false, source: "session", keyId: null, user: null, companyIds: ["company-a"],
  memberships: [{ companyId: "company-a", membershipRole, status: "active" }] });
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><AgentConversationsSidebar /></QueryClientProvider>); });
}
async function openContact(name: string) {
  await act(async () => container.querySelector<HTMLAnchorElement>(`a[href="/chats/${name}"]`)!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.companyId = "company-a"; state.pathname = "/A/chats/alice";
  state.terminate.mockReset(); state.pushToast.mockReset();
  // Refetches after an archive read whatever the test last cached.
  state.listAgents.mockReset().mockImplementation(async () => client.getQueryData(queryKeys.agents.list("company-a")));
  state.listChats.mockReset().mockImplementation(async () => client.getQueryData(queryKeys.agentChats.list("company-a", "user-a")));
  state.navigate.mockReset(); state.closeSidebar.mockReset(); state.ensure.mockReset(); state.getAgent.mockReset(); state.newAgent.mockReset(); localStorage.clear();
  sidebarInputs.length = 0;
  state.ensure.mockImplementation(async (_company, id) => chat(id));
  memberships.agentMemberships = {};
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
  client.setQueryData(queryKeys.agents.list("company-a"), roster);
  client.setQueryData(queryKeys.access.currentBoardAccess, boardAccess("operator"));
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableBuiltInAgents: false });
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("alice")]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
it("opens every contact without creating a conversation before the first message", async () => {
  await render();
  expect(container.querySelectorAll('nav[aria-label="Agent conversations"] a')).toHaveLength(2);
  expect(container.querySelector('[aria-label="Add chat"]')).toBeNull();
  expect(container.querySelector('[aria-label="Search chats"]')).not.toBeNull();
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
  expect(state.ensure).not.toHaveBeenCalled();
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
  const savedPins = JSON.stringify(agents.map(agent => `agent-chat:company-a:${agent.id}`));
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

it("lists a terminated agent's history only while its chat is open, by id, without offering it for new chats", async () => {
  const retired = { ...roster[0], id: "retired-id", name: "Retired", status: "terminated", urlKey: "alice" };
  client.setQueryData(queryKeys.agents.detail(retired.id), retired);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat(retired.id), chat("alice")]);
  await render();
  expect(container.querySelector('a[href="/chats/retired-id"]')).toBeNull();
  expect(state.getAgent).not.toHaveBeenCalled();
  state.pathname = "/A/chats/retired-id";
  await render();
  expect(container.querySelector('[aria-label="Open actions for Retired"]')).toBeNull();
  const historyLink = container.querySelector<HTMLAnchorElement>('a[href="/chats/retired-id"]')!;
  expect(historyLink.textContent).toContain("RetiredTerminated");
  await act(async () => historyLink.click());
  expect(state.navigate).toHaveBeenLastCalledWith("/chats/retired-id");
  expect(state.ensure).not.toHaveBeenCalled();
});

it("keeps healthy chats usable while a historical lookup fails and retries", async () => {
  const retired = { ...roster[0], id: "retired-id", name: "Retired", status: "terminated" };
  state.getAgent.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValue(retired);
  state.pathname = "/A/chats/retired-id";
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

async function openArchiveDialog(name: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="Open actions for ${name}"]`)!;
  await act(async () => {
    trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: false, pointerType: "mouse" } as PointerEventInit));
  });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(element => element.textContent === "Archive agent")!;
  await act(async () => item.click());
}
function dialogButton(label: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find(button => button.textContent === label)!;
}

it("offers Archive agent only to boards that can manage agents, and never for built-in agents", async () => {
  client.setQueryData(queryKeys.access.currentBoardAccess, boardAccess("viewer"));
  await render();
  expect(container.querySelector('[aria-label="Open actions for bob"]')).toBeNull();
  expect(container.querySelector('[aria-label="Pin bob"]')).not.toBeNull();
  client.setQueryData(queryKeys.access.currentBoardAccess, boardAccess("operator"));
  client.setQueryData(queryKeys.instance.experimentalSettings, { enableBuiltInAgents: true });
  client.setQueryData(queryKeys.builtInAgents.list("company-a"), [{ agentId: "bob", status: "ready" }]);
  await render();
  expect(container.querySelector('[aria-label="Open actions for alice"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Open actions for bob"]')).toBeNull();
});

it("archives only after confirmation, then drops the agent from the chat list", async () => {
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("alice"), chat("bob")]);
  state.terminate.mockImplementation(async (id: string) => {
    client.setQueryData(queryKeys.agents.list("company-a"), roster.map(agent => agent.id === id ? { ...agent, status: "terminated" } : agent));
    return { ...roster.find(agent => agent.id === id)!, status: "terminated" };
  });
  await render();
  await openArchiveDialog("bob");
  expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Archive bob?");
  await act(async () => dialogButton("Cancel").click());
  expect(state.terminate).not.toHaveBeenCalled();
  await openArchiveDialog("bob");
  await act(async () => dialogButton("Archive agent").click());
  await vi.waitFor(() => expect(container.querySelector('a[href="/chats/bob"]')).toBeNull());
  expect(state.terminate).toHaveBeenCalledWith("bob", "company-a");
  expect(state.navigate).not.toHaveBeenCalled();
  expect(container.querySelector('a[href="/chats/alice"]')).not.toBeNull();
});

it("keeps an open chat readable by id after archiving its agent", async () => {
  // The id differs from the urlKey, so the archive really changes the route.
  const alice = { ...roster[0], id: "agent-alice" } as Agent;
  const archived = { ...alice, status: "terminated" } as Agent;
  client.setQueryData(queryKeys.agents.list("company-a"), [alice, roster[1]]);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [{ ...chat("alice"), conversationAgentId: alice.id }]);
  state.terminate.mockImplementation(async () => {
    // The live roster excludes terminated agents.
    client.setQueryData(queryKeys.agents.list("company-a"), [roster[1]]);
    return archived;
  });
  state.getAgent.mockResolvedValue(archived);
  await render();
  await openArchiveDialog("alice");
  await act(async () => dialogButton("Archive agent").click());
  await vi.waitFor(() => expect(state.navigate).toHaveBeenCalledWith("/chats/agent-alice", { replace: true }));
  state.pathname = "/A/chats/agent-alice";
  await render();
  await vi.waitFor(() => expect(container.querySelector('a[href="/chats/agent-alice"]')).not.toBeNull());
  expect(state.getAgent).toHaveBeenCalledWith("agent-alice", "company-a");
  expect(container.querySelector('a[href="/chats/alice"]')).toBeNull();
  expect(container.querySelector('a[href="/chats/bob"]')).not.toBeNull();
});

it("reports a failed archive and keeps the agent listed", async () => {
  state.terminate.mockRejectedValue(new Error("Forbidden"));
  await render();
  await openArchiveDialog("bob");
  await act(async () => dialogButton("Archive agent").click());
  await vi.waitFor(() => expect(state.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Couldn’t archive agent", body: "Forbidden", tone: "error" })));
  expect(container.querySelector('a[href="/chats/bob"]')).not.toBeNull();
});
