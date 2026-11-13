// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { SidebarAgentChats } from "./SidebarAgentChats";
import { queryKeys } from "@/lib/queryKeys";

const state = vi.hoisted(() => ({ companyId: "company-a", navigate: vi.fn(), closeSidebar: vi.fn(), list: vi.fn() }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("@/context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: true, setSidebarOpen: state.closeSidebar }) }));
vi.mock("@/lib/router", () => ({ useLocation: () => ({ pathname: "/A/dashboard" }), useNavigate: () => state.navigate }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: state.list } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: () => ({ user: { id: "user-a" } }) } }));
vi.mock("@/hooks/useResourceMemberships", () => ({
  useResourceMemberships: () => ({ data: { starredAgentIds: [] } }),
  useResourceMembershipMutation: () => ({ mutate: vi.fn() }),
}));
vi.mock("./AgentChatSidebar", () => ({ AgentChatSidebar: ({ onOpenChat }: { onOpenChat: () => void }) => <button onClick={onOpenChat}>Chat with an agent</button> }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
const agent = (id: string, companyId: string) => ({ id, companyId, name: id, urlKey: id, role: "engineer", title: "Engineer", icon: null, status: "idle" } as Agent);
async function render() {
  await act(async () => { root.render(<QueryClientProvider client={client}><SidebarAgentChats /></QueryClientProvider>); });
}
async function openPicker() {
  await act(async () => container.querySelector("button")!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  state.companyId = "company-a";
  state.navigate.mockClear();
  state.closeSidebar.mockClear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "user-a" } });
  client.setQueryData(queryKeys.agents.list("company-a"), [agent("alice", "company-a"), agent("never-visited", "company-a")]);
  client.setQueryData(queryKeys.agents.list("company-b"), [agent("bob", "company-b")]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

describe("SidebarAgentChats", () => {
  it("opens an unvisited agent from the full roster and closes the mobile sidebar", async () => {
    await render();
    await openPicker();
    const options = [...document.querySelectorAll<HTMLElement>("[role=option]")];
    expect(options).toHaveLength(2);
    await act(async () => options.find((item) => item.textContent?.includes("never-visited"))!.click());
    expect(state.navigate).toHaveBeenCalledWith("/chats/never-visited");
    expect(state.closeSidebar).toHaveBeenCalledWith(false);
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("drops the open picker across company and user changes", async () => {
    await render();
    await openPicker();
    state.companyId = "company-b";
    await render();
    expect(document.querySelector("[role=dialog]")).toBeNull();
    await openPicker();
    const options = [...document.querySelectorAll("[role=option]")];
    expect(options).toHaveLength(1);
    expect(options[0].textContent).toContain("bob");
    await act(async () => {
      client.setQueryData(queryKeys.auth.session, { user: { id: "user-b" } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.querySelector("[role=dialog]")).toBeNull();
    state.companyId = "company-a";
    await render();
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });
});
