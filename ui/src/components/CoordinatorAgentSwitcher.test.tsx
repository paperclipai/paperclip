// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent, Issue } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { CoordinatorAgentSwitcher } from "./CoordinatorAgentSwitcher";

const state = vi.hoisted(() => ({ companyId: "company-a", navigate: vi.fn(), listChats: vi.fn(), listAgents: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false, setSidebarOpen: vi.fn() }) }));
vi.mock("@/lib/router", () => ({ useNavigate: () => state.navigate }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: state.listAgents } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { list: state.listChats } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: () => ({ user: { id: "user-a" } }) } }));

const agents = ["Mira", "Alex", "Sam"].map(name => ({ id: name, name, urlKey: name.toLowerCase(), companyId: "company-a", role: "engineer", status: "idle" } as Agent));
const chat = (agentId: string, unread: boolean) => ({ id: `chat-${agentId}`, conversationAgentId: agentId, isUnreadForMe: unread } as Issue);
let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
async function render() {
  await act(async () => root.render(<QueryClientProvider client={client}><CoordinatorAgentSwitcher agent={agents[0]} /></QueryClientProvider>));
}
async function open() {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Switch agent"]')!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.companyId = "company-a";
  state.navigate.mockReset(); state.listChats.mockReset(); state.listAgents.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
  client.setQueryData(queryKeys.agents.list("company-a"), agents);
  client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("Alex", true), chat("Sam", false)]);
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });

it("opens cached badges without requests and follows read-state cache updates", async () => {
  await render(); await open();
  expect(document.querySelector('[aria-label="Unread messages from Alex"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Unread messages from Sam"]')).toBeNull();
  await act(async () => {
    client.setQueryData(queryKeys.agentChats.list("company-a", "user-a"), [chat("Alex", false), chat("Sam", true)]);
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[aria-label="Unread messages from Alex"]')).toBeNull();
  expect(document.querySelector('[aria-label="Unread messages from Sam"]')).not.toBeNull();
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes("Sam"))!.click());
  expect(state.navigate).toHaveBeenCalledWith("/chats/sam");
  expect(client.getQueryData<Issue[]>(queryKeys.agentChats.list("company-a", "user-a"))![1].isUnreadForMe).toBe(true);
  await open();
  expect(state.listChats).not.toHaveBeenCalled();
  expect(state.listAgents).not.toHaveBeenCalled();
});

it("keeps switching available while unread history is still loading", async () => {
  client.removeQueries({ queryKey: queryKeys.agentChats.list("company-a", "user-a") });
  state.listChats.mockReturnValue(new Promise(() => {}));
  await render(); await open();
  expect(document.querySelectorAll('[role="option"]')).toHaveLength(3);
  expect(document.querySelector('[role="status"]')).toBeNull();
  await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')][1].click());
  expect(state.navigate).toHaveBeenCalledWith("/chats/alex");
  expect(state.listChats).toHaveBeenCalledTimes(1);
});

it("does not carry unread badges into a different account", async () => {
  await render(); await open();
  await act(async () => {
    client.setQueryData(queryKeys.agentChats.list("company-a", "user-b"), [chat("Sam", true)]);
    client.setQueryData(queryKeys.auth.session, { user: { id: "user-b" } });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(document.querySelector('[aria-label="Unread messages from Alex"]')).toBeNull();
  expect(document.querySelector('[aria-label="Unread messages from Sam"]')).not.toBeNull();
});
