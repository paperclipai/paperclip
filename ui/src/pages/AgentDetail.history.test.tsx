// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { HeartbeatRun } from "@paperclipai/shared";
import { afterEach, expect, it, vi } from "vitest";
import { RunsTab, AgentDetail } from "./AgentDetail";
import { RunsTab as ProductionRunsTab, AgentDetail as ProductionAgentDetail } from "./AgentDetail.production";
import { ToastProvider } from "../context/ToastContext";
import { PanelProvider } from "../context/PanelContext";
import { BreadcrumbProvider } from "../context/BreadcrumbContext";
import { Route, Routes } from "react-router-dom";
import { queryKeys } from "../lib/queryKeys";

const mockAgent = {
  id: "agent-1",
  companyId: "company-1",
  name: "Alpha Agent",
  urlKey: "alpha",
  role: "engineer",
  title: "Engineer",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "paperclip_runner",
  adapterConfig: { provider: "codex" },
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  permissions: { canCreateAgents: false },
  pauseReason: null,
  pausedAt: null,
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  chainOfCommand: [],
  access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
};

const { get, mobile } = vi.hoisted(() => ({ get: vi.fn(), mobile: { value: false } }));
vi.mock("../api/agents", () => ({
  agentsApi: {
    get: vi.fn(async () => mockAgent),
    runtimeState: vi.fn(async () => ({})),
    taskSessions: vi.fn(async () => []),
    instructionsBundle: vi.fn(async () => ({ entryFile: "AGENTS.md", files: [] })),
    permissions: vi.fn(async () => ({})),
    hierarchy: vi.fn(async () => ({ root: null, members: [] })),
  },
}));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { get, events: async () => [], workspaceOperations: async () => [], list: async () => [] } }));
vi.mock("../api/client", () => ({
  api: {
    get: async (url?: string) => {
      if (typeof url === "string" && url.includes("/budgets/overview")) {
        return {
          policies: [],
          activeIncidents: [],
          pausedAgentCount: 0,
          pausedProjectCount: 0,
        };
      }
      return [];
    },
  },
}));
vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: {
    listMine: async () => ({
      projectMemberships: {},
      agentMemberships: {},
      starredProjectIds: [],
      starredAgentIds: [],
      starredDocumentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      documentStarredAt: {},
      updatedAt: null,
    }),
    updateProject: async () => ({}),
    updateAgent: async () => ({}),
  },
}));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: async () => ({ companyIds: ["company-1"], memberships: [] }) } }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: mobile.value }) }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", issuePrefix: "TEST" }, companies: [{ id: "company-1", issuePrefix: "TEST" }], setSelectedCompanyId: vi.fn() }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: vi.fn() }) }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { get.mockReset(); });

it.each([
  { Tab: RunsTab, isMobile: false }, { Tab: ProductionRunsTab, isMobile: false },
  { Tab: RunsTab, isMobile: true }, { Tab: ProductionRunsTab, isMobile: true },
])("renders an older selected run when history is empty (%#)", async ({ Tab, isMobile }) => {
  mobile.value = isMobile;
  const run = { id: "older-run", companyId: "company-1", agentId: "agent-1", status: "succeeded", invocationSource: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usageJson: null, resultJson: null,
    contextSnapshot: null, exitCode: 0, error: null, logRef: null, startedAt: null, finishedAt: null } as unknown as HeartbeatRun;
  get.mockResolvedValue(run);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><PanelProvider><ToastProvider>
      <Tab runs={[]} companyId="company-1" agentId="agent-1" agentRouteId="agent-1" selectedRunId="older-run" adapterType="codex_local" adapterConfig={{}} />
    </ToastProvider></PanelProvider></MemoryRouter></QueryClientProvider>));
    await vi.waitFor(async () => { await act(async () => {}); expect(element.textContent).toContain("succeeded"); });
    expect(element.textContent).not.toContain("No runs yet.");
    expect(get).toHaveBeenCalledWith("older-run");
  } finally { await act(async () => root.unmount()); client.clear(); element.remove(); }
});

it.each([
  { Component: AgentDetail, path: "/TEST/agents/agent-1/runs/older-run", shouldOfferTerminate: false },
  { Component: AgentDetail, path: "/TEST/agents/agent-1/overview", shouldOfferTerminate: true },
  { Component: ProductionAgentDetail, path: "/TEST/agents/agent-1/runs/older-run", shouldOfferTerminate: false },
  { Component: ProductionAgentDetail, path: "/TEST/agents/agent-1/dashboard", shouldOfferTerminate: true },
])("guards terminate action on run inspection routes vs ordinary views (%#)", async ({ Component, path, shouldOfferTerminate }) => {
  mobile.value = false;
  const run = { id: "older-run", companyId: "company-1", agentId: "agent-1", status: "succeeded", invocationSource: "manual",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", usageJson: null, resultJson: null,
    contextSnapshot: null, exitCode: 0, error: null, logRef: null, startedAt: null, finishedAt: null } as unknown as HeartbeatRun;
  get.mockResolvedValue(run);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData([...queryKeys.agents.detail("agent-1"), "company-1"], mockAgent);
  client.setQueryData([...queryKeys.agents.detail("alpha"), "company-1"], mockAgent);
  client.setQueryData(queryKeys.resourceMemberships.mine("company-1"), {
    projectMemberships: {},
    agentMemberships: {},
    starredProjectIds: [],
    starredAgentIds: [],
    starredDocumentIds: [],
    projectStarredAt: {},
    agentStarredAt: {},
    documentStarredAt: {},
    updatedAt: null,
  });
  client.setQueryData(queryKeys.budgets.overview("company-1"), {
    policies: [],
    activeIncidents: [],
    pausedAgentCount: 0,
    pausedProjectCount: 0,
  });
  const element = document.createElement("div"); document.body.append(element);
  const root = createRoot(element);
  try {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <PanelProvider>
            <ToastProvider>
              <BreadcrumbProvider companyName="TEST">
                <Routes>
                  <Route path="/:companyPrefix/agents/:agentId/runs/:runId" element={<Component />} />
                  <Route path="/agents/:agentId/runs/:runId" element={<Component />} />
                  <Route path="/:companyPrefix/agents/:agentId/:tab" element={<Component />} />
                  <Route path="/agents/:agentId/:tab" element={<Component />} />
                </Routes>
              </BreadcrumbProvider>
            </ToastProvider>
          </PanelProvider>
        </MemoryRouter>
      </QueryClientProvider>
    ));
    await vi.waitFor(async () => {
      const menuButton = element.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]');
      expect(menuButton).toBeTruthy();
    });
    const menuButton = element.querySelector<HTMLButtonElement>('[aria-label="Open actions for Alpha Agent"]');
    await act(async () => {
      menuButton?.click();
    });
    const buttons = Array.from(document.body.querySelectorAll("button")).map((b) => b.textContent?.trim());
    if (shouldOfferTerminate) {
      expect(buttons).toContain("Terminate");
    } else {
      expect(buttons).not.toContain("Terminate");
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    element.remove();
    document.body.innerHTML = "";
  }
});
