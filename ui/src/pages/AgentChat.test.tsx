// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { AgentChat } from "./AgentChat";

const api = vi.hoisted(() => ({ enabled: true, list: vi.fn(), get: vi.fn(), getChat: vi.fn(), ensure: vi.fn(), session: vi.fn() }));
const agentId = "18c5ad50-9d70-4e24-bd82-337e1d45a414";
vi.mock("@/api/agents", () => ({ agentsApi: { list: api.list, get: api.get } }));
vi.mock("@/api/agentChats", () => ({ agentChatsApi: { get: api.getChat, ensure: api.ensure } }));
vi.mock("@/api/auth", () => ({ authApi: { getSession: api.session } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-a" }) }));
vi.mock("@/hooks/useAgentChatEnabled", () => ({ useAgentChatEnabled: () => ({ enabled: api.enabled, loaded: true }) }));
vi.mock("@/lib/router", () => ({ useParams: () => ({ agentRef: "18c5ad50-9d70-4e24-bd82-337e1d45a414" }), Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a> }));
vi.mock("./IssueDetail", () => ({ TaskDetailSurface: ({ conversation }: { conversation: { agent: Agent } }) => <div>History for {conversation.agent.name}</div> }));

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync(() => {});
}
async function waitFor(assertion: () => void) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { assertion(); return; } catch (error) { if (attempt === 49) throw error; await settle(); }
  }
}
function render() {
  flushSync(() => root.render(<QueryClientProvider client={client}><AgentChat /></QueryClientProvider>));
}
async function failRoster(status: number, cached = true) {
  if (cached) client.setQueryData(queryKeys.agents.list("company-a"), []);
  api.list.mockRejectedValue(new ApiError(status === 429 ? "Rate limited" : "Denied", status, {}));
  await client.fetchQuery({ queryKey: queryKeys.agents.list("company-a"), queryFn: api.list, staleTime: 0 }).catch(() => {});
  expect(client.getQueryState(queryKeys.agents.list("company-a"))?.status).toBe("error");
}
beforeEach(() => {
  vi.clearAllMocks();
  api.enabled = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity, gcTime: Infinity } } });
  client.setQueryData(queryKeys.auth.session, { user: { id: "viewer-a" } });
  api.session.mockResolvedValue({ user: { id: "viewer-a" } });
  api.get.mockResolvedValue({ id: agentId, companyId: "company-a", name: "Retired helper", status: "terminated" });
  api.getChat.mockResolvedValue({ id: "existing-chat" });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); container.remove(); });

it("explains when Agent Chat is disabled without creating a conversation", async () => {
  api.enabled = false;
  api.list.mockResolvedValue([{ id: agentId, companyId: "company-a", name: "Helper" }]);
  render();
  await waitFor(() => expect(container.textContent).toContain("Agent Chat is disabled"));
  expect(api.ensure).not.toHaveBeenCalled();
  expect(api.getChat).not.toHaveBeenCalled();
});

it.each(["cached_refetch_failed", "fresh"])("opens historical chat from an available roster (%s)", async state => {
  if (state === "cached_refetch_failed") await failRoster(429);
  else client.setQueryData(queryKeys.agents.list("company-a"), []);
  render();
  await waitFor(() => expect(container.textContent).toContain("History for Retired helper"));
  expect(api.get).toHaveBeenCalledWith(agentId, "company-a");
  expect(api.getChat).toHaveBeenCalledWith("company-a", agentId);
  expect(container.textContent).not.toContain("Agent not found");
  expect(api.ensure).not.toHaveBeenCalled();
});

it("offers a working retry when the historical lookup also fails", async () => {
  await failRoster(429);
  api.get.mockRejectedValue(new ApiError("Rate limited", 429, {}));
  render();
  await waitFor(() => expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(true));
  expect(container.textContent).not.toContain("Agent not found");
  api.get.mockResolvedValue({ id: agentId, companyId: "company-a", name: "Retired helper" });
  flushSync(() => [...container.querySelectorAll("button")].find(button => button.textContent?.trim() === "Retry")!.click());
  await waitFor(() => expect(container.textContent).toContain("History for Retired helper"));
  expect(api.ensure).not.toHaveBeenCalled();
});

it.each([[403, true], [429, false]] as const)("retains roster error controls without starting a historical lookup (%s, cached %s)", async (status, cached) => {
  await failRoster(status, cached);
  render();
  await waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
  expect([...container.querySelectorAll("button")].some(button => button.textContent?.trim() === "Retry")).toBe(status === 429);
  expect(api.get).not.toHaveBeenCalled();
  expect(api.getChat).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Agent not found");
});

it("does not display a historical agent from another company", async () => {
  await failRoster(429);
  api.get.mockResolvedValue({ id: agentId, companyId: "company-b", name: "Private helper" });
  render();
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  await waitFor(() => expect(container.textContent).toContain("Agent not found"));
  expect(container.textContent).not.toContain("Private helper");
  expect(api.getChat).not.toHaveBeenCalled();
});
