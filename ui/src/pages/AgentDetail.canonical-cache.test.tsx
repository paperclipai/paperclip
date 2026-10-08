// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from "react-router-dom";
import type { AgentDetail as AgentDetailRecord } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentDetail } from "./AgentDetail";
import { queryKeys } from "../lib/queryKeys";

const mocks = vi.hoisted(() => ({ get: vi.fn(), setCompany: vi.fn(), noop: vi.fn(), empty: [], selectedCompanyId: "company-B" as string | undefined }));
vi.mock("../api/agents", () => ({ agentsApi: { get: mocks.get } }));
// Keep the real detail observer/cache; unrelated page queries are outside this regression.
vi.mock("@tanstack/react-query", async (original) => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: (options: Parameters<typeof actual.useQuery>[0]) =>
    options.queryKey[0] === "agents" && options.queryKey[1] === "detail"
      ? actual.useQuery(options)
      : { data: undefined, isLoading: false } };
});
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({
  companies: [{ id: "company-A", issuePrefix: "AAA" }, { id: "company-B", issuePrefix: "BBB" }],
  selectedCompanyId: mocks.selectedCompanyId, selectedCompany: { id: "company-B", issuePrefix: "BBB" },
  setSelectedCompanyId: mocks.setCompany,
}) }));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ closePanel: mocks.noop }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: mocks.noop }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../hooks/useResourceMemberships", () => ({
  useResourceMemberships: () => ({ data: mocks.empty }),
  useResourceMembershipMutation: () => ({ isPending: false }),
  resourceMembershipState: () => "joined", isStarred: () => false,
}));
vi.mock("../components/AgentActionButtons", () => ({ AgentActionButtons: ({ agent }: { agent: AgentDetailRecord }) =>
  <output data-agent-status>{agent.status === "paused" ? "Paused" : agent.status}</output> }));
vi.mock("../components/AgentCharacter", () => ({ AgentCharacter: () => null }));
vi.mock("@/components/primary-agent/PrimaryAgentPresentation", () => ({ PrimaryAgentIndicator: () => null, SetPrimaryAgentButton: () => null }));
vi.mock("./agent-skills/AgentSkillsTab", () => ({ AgentSkillsTab: () => null }));

const uuid = "11111111-1111-4111-8111-111111111111";
const detailKey = (ref: string, company = "company-B") => [...queryKeys.agents.detail(ref), company];
function agent(companyId = "company-B", overrides: Partial<AgentDetailRecord> = {}): AgentDetailRecord {
  return { id: uuid, companyId, name: "Maya", urlKey: "maya", status: "idle", role: "engineer",
    adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    budgetMonthlyCents: 0, spentMonthlyCents: 0, metadata: null, ...overrides } as AgentDetailRecord;
}
let client: QueryClient;
let root: Root;
let container: HTMLDivElement;
let navigate: NavigateFunction;
function Location() { navigate = useNavigate(); return <output data-location>{useLocation().pathname}</output>; }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function settle() { for (let i = 0; i < 8; i++) await flush(); }
async function mount(path = `/BBB/agents/${uuid}/skills`) {
  await act(async () => root.render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[path]}>
      <Location /><Routes>
        <Route path="/:companyPrefix/agents/:agentId/:tab" element={<AgentDetail />} />
        <Route path="/agents/:agentId/:tab" element={<AgentDetail />} />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>));
  await settle();
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false }, mutations: { retry: false } } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  mocks.get.mockReset(); mocks.setCompany.mockClear(); mocks.selectedCompanyId = "company-B";
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

it("does not overwrite newer canonical status, permissions, or freshness with an older UUID snapshot", async () => {
  const old = agent();
  const newer = agent("company-B", { status: "paused", permissions: { canCreateAgents: false } });
  const updatedAt = Date.now() - 5_000;
  client.setQueryData(detailKey(uuid), old, { updatedAt: Date.now() - 60_000 });
  client.setQueryData(detailKey("maya"), newer, { updatedAt });
  mocks.get.mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(container.querySelector("[data-location]")?.textContent).toBe("/BBB/agents/maya/skills");
  expect(client.getQueryData(detailKey("maya"))).toEqual(newer);
  expect(client.getQueryState(detailKey("maya"))?.dataUpdatedAt).toBe(updatedAt);
  expect(container.textContent).toContain("Paused");
});

it.each(["stale", "invalidated"])("keeps %s UUID continuity non-authoritative and fetches canonical access/status", async (source) => {
  client.setQueryData(detailKey(uuid), agent(), { updatedAt: Date.now() - (source === "stale" ? 60_000 : 1_000) });
  if (source === "invalidated") await client.invalidateQueries({ queryKey: detailKey(uuid) });
  let resolveCanonical!: (value: AgentDetailRecord) => void;
  mocks.get.mockImplementation((ref: string) => ref === "maya"
    ? new Promise(resolve => { resolveCanonical = resolve; })
    : new Promise(() => {}));
  await mount();
  expect(mocks.get).toHaveBeenCalledWith("maya", "company-B");
  expect(client.getQueryData(detailKey("maya"))).toBeUndefined();
  expect(client.getQueryState(detailKey("maya"))?.dataUpdatedAt).toBe(0);
  expect(container.textContent).toContain("Maya");
  const authoritative = agent("company-B", { status: "paused", permissions: { canCreateAgents: false } });
  await act(async () => resolveCanonical(authoritative));
  await settle();
  expect(client.getQueryData(detailKey("maya"))).toEqual(authoritative);
  expect(container.textContent).toContain("Paused");
});

it("surfaces a canonical access denial instead of retaining placeholder data, then recovers on refetch", async () => {
  client.setQueryData(detailKey(uuid), agent(), { updatedAt: Date.now() - 60_000 });
  let deny!: (error: Error) => void;
  mocks.get.mockImplementation((ref: string) => ref === "maya"
    ? new Promise((_resolve, reject) => { deny = reject; }) : new Promise(() => {}));
  await mount();
  expect(container.textContent).toContain("Maya");
  await act(async () => deny(new Error("Access revoked")));
  await settle();
  expect(container.textContent).toContain("Access revoked");
  expect(container.querySelector("[data-agent-status]")).toBeNull();
  expect(client.getQueryData(detailKey("maya"))).toBeUndefined();
  const updated = agent("company-B", { status: "paused" });
  mocks.get.mockResolvedValue(updated);
  await act(async () => { await client.refetchQueries({ queryKey: detailKey("maya"), exact: true }); });
  await settle();
  expect(container.textContent).not.toContain("Access revoked");
  expect(container.textContent).toContain("Paused");
});

it("preserves an invalidated canonical entry and its authoritative refetch", async () => {
  const updatedAt = Date.now() - 1_000;
  const newer = agent("company-B", { status: "paused" });
  client.setQueryData(detailKey(uuid), agent());
  client.setQueryData(detailKey("maya"), newer, { updatedAt });
  await client.invalidateQueries({ queryKey: detailKey("maya"), exact: true });
  mocks.get.mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(mocks.get).toHaveBeenCalledWith("maya", "company-B");
  expect(client.getQueryData(detailKey("maya"))).toEqual(newer);
  expect(client.getQueryState(detailKey("maya"))).toMatchObject({ dataUpdatedAt: updatedAt, isInvalidated: true });
});

it("does not canonicalize a UUID snapshot whose authoritative request has failed", async () => {
  client.setQueryData(detailKey(uuid), agent());
  await client.fetchQuery({ queryKey: detailKey(uuid), staleTime: 0, queryFn: async () => { throw new Error("Access revoked"); } }).catch(() => {});
  mocks.get.mockRejectedValue(new Error("Access revoked"));
  await mount();
  expect(container.querySelector("[data-location]")?.textContent).toBe(`/BBB/agents/${uuid}/skills`);
  expect(mocks.get).not.toHaveBeenCalledWith("maya", "company-B");
  expect(container.textContent).toContain("Access revoked");
});

it("rejects an already cached mismatched-company UUID before rendering or navigation", async () => {
  client.setQueryData(detailKey(uuid), agent("company-A", { name: "A Maya" }));
  await mount();
  expect(client.getQueryData(detailKey("maya"))).toBeUndefined();
  expect(container.querySelector("[data-location]")?.textContent).toBe(`/BBB/agents/${uuid}/skills`);
  expect(container.textContent).not.toContain("A Maya");
  expect(container.textContent).toContain("Agent does not belong to the requested company");
});

it.each(["/BBB/agents/other/skills", "/AAA/agents/maya/skills"])("does not carry UUID placeholder into an unrelated route %s", async (path) => {
  client.setQueryData(detailKey(uuid), agent());
  mocks.get.mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(container.textContent).toContain("Maya");
  await act(async () => { await navigate(path); });
  await settle();
  expect(container.querySelector("[data-agent-status]")).toBeNull();
  expect(container.textContent).not.toContain("Maya");
  expect(client.getQueryData(detailKey("maya", "company-A"))).toBeUndefined();
});

it("fails closed for an unscoped UUID without promoting the response into a company cache", async () => {
  mocks.selectedCompanyId = undefined;
  mocks.get.mockResolvedValue(agent("company-A", { name: "A Maya" }));
  await mount(`/agents/${uuid}/skills`);
  expect(container.textContent).toContain("Agent does not belong to the requested company");
  expect(container.textContent).not.toContain("A Maya");
  expect(client.getQueryData(detailKey("maya", "company-A"))).toBeUndefined();
  expect(mocks.setCompany).not.toHaveBeenCalled();
});

it.each([false, true])("fails closed for an A UUID under B without contaminating B/maya (cached=%s)", async (cached) => {
  const b = agent("company-B", { id: "22222222-2222-4222-8222-222222222222", name: "B Maya" });
  if (cached) client.setQueryData(detailKey("maya"), b);
  mocks.get.mockResolvedValue(agent("company-A", { name: "A Maya" }));
  await mount();
  expect(mocks.get).toHaveBeenCalledWith(uuid, "company-B");
  expect(client.getQueryData(detailKey("maya"))).toEqual(cached ? b : undefined);
  expect(container.querySelector("[data-location]")?.textContent).toBe(`/BBB/agents/${uuid}/skills`);
  expect(container.textContent).not.toContain("A Maya");
  expect(container.textContent).toContain("Agent does not belong to the requested company");
  expect(mocks.setCompany).not.toHaveBeenCalled();
});
