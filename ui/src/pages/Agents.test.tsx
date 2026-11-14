// @vitest-environment jsdom

import { act as reactAct, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import type { Agent, Environment, EnvironmentCapabilities } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { queryKeys } from "@/lib/queryKeys";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastProvider } from "../context/ToastContext";
import type { BuiltInAgentState } from "../api/builtInAgents";
import { Agents, filterAgents, filterOrgTree } from "./Agents";
import { Agents as ProductionAgents } from "./Agents.production";
import type { AgentOrgChainHealth } from "@paperclipai/shared";

const mockRouterState = vi.hoisted(() => ({
  pathname: "/agents/all",
  navigate: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  org: vi.fn(),
}));

const mockBuiltInAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  provision: vi.fn(),
  reset: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
}));

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
}));

const mockResourceMembershipsApi = vi.hoisted(() => ({
  listMine: vi.fn(),
  updateAgent: vi.fn(),
}));

const mockOpenNewAgent = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSidebarState = vi.hoisted(() => ({ isMobile: false }));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useLocation: () => ({ pathname: mockRouterState.pathname, search: "", hash: "", state: null }),
  useNavigate: () => mockRouterState.navigate,
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewAgent: mockOpenNewAgent }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: mockSetBreadcrumbs }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: mockSidebarState.isMobile }),
}));

vi.mock("../api/ai-connections", () => ({ aiConnectionsApi: { list: vi.fn(async () => ({ currentUserId: "board", canManageConnections: true, connections: [] })) } }));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/builtInAgents", () => ({
  builtInAgentsApi: mockBuiltInAgentsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/resourceMemberships", () => ({
  resourceMembershipsApi: mockResourceMembershipsApi,
}));

vi.mock("../adapters/adapter-display-registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("../adapters/adapter-display-registry")>(),
  getAdapterLabel: (type: string) => type,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function makeAgent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeBuiltInAgentState(overrides: Partial<BuiltInAgentState> = {}): BuiltInAgentState {
  return {
    definition: {
      key: "briefs",
      displayName: "Briefs Agent",
      featureKeys: ["Briefs"],
      shortPurpose: "Generates briefs.",
      defaultInstructions: "You are Paperclip's built-in Briefs agent.",
      defaultRole: "engineer",
    },
    status: "ready",
    agentId: "built-in-agent",
    agent: null,
    pauseReason: null,
    ...overrides,
  };
}

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Daytona Sandbox",
    description: null,
    driver: "sandbox",
    status: "active",
    config: { provider: "daytona" },
    envVars: {},
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const environmentCapabilities: EnvironmentCapabilities = {
  adapters: [],
  drivers: {
    local: "supported",
    ssh: "supported",
    sandbox: "supported",
    plugin: "supported",
  },
  sandboxProviders: {
    fake: {
      status: "supported",
      supportsSavedProbe: true,
      supportsUnsavedProbe: true,
      supportsRunExecution: true,
      supportsReusableLeases: true,
      supportsInteractiveSetup: false,
      interactiveSetupConnectionTypes: [],
      supportsTemplateCapture: false,
      supportsTemplateDelete: false,
      supportsLoginPty: false,
      displayName: "Fake",
      source: "builtin",
    },
    daytona: {
      status: "supported",
      supportsSavedProbe: true,
      supportsUnsavedProbe: true,
      supportsRunExecution: true,
      supportsReusableLeases: true,
      supportsInteractiveSetup: true,
      interactiveSetupConnectionTypes: ["ssh"],
      supportsTemplateCapture: true,
      supportsTemplateDelete: true,
      supportsLoginPty: true,
      displayName: "Daytona",
      source: "plugin",
    },
  },
};

function makeInstanceSettings({
  defaultEnvironmentId = null,
  enableEnvironments = true,
  enableBuiltInAgents = false,
}: {
  defaultEnvironmentId?: string | null;
  enableEnvironments?: boolean;
  enableBuiltInAgents?: boolean;
} = {}) {
  return {
    id: "instance-settings-1",
    defaultEnvironmentId,
    general: {
      censorUsernameInLogs: true,
      feedbackDataSharingPreference: "prompt",
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
      executionMode: "any",
    },
    experimental: {
      enableEnvironments,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: false,
      enableAgentChat: false,
      enableConferenceRoomChat: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: false,
      enableExternalObjects: false,
      enableBuiltInAgents,
      autoRestartDevServerWhenIdle: false,
    },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

const invalidOrgChainHealth: AgentOrgChainHealth = {
  status: "invalid_org_chain",
  reason: "terminated_ancestor",
  fullChain: [
    {
      id: "agent-1",
      companyId: "company-1",
      name: "Alpha",
      status: "active",
      reportsTo: "manager-1",
      depth: 0,
      relation: "self",
    },
    {
      id: "manager-1",
      companyId: "company-1",
      name: "Terminated Manager",
      status: "terminated",
      reportsTo: null,
      depth: 1,
      relation: "ancestor",
    },
  ],
  firstInvalidAncestor: { id: "manager-1", name: "Terminated Manager", status: "terminated" },
  invalidAncestors: [{ id: "manager-1", name: "Terminated Manager", status: "terminated" }],
  repairGuidance: "Alpha reports through terminated ancestor Terminated Manager.",
};

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function findAgentRow(container: HTMLElement, agentName: string): HTMLElement | null {
  return Array.from(container.querySelectorAll("a")).find((row) => row.textContent?.includes(agentName)) ?? null;
}

describe("agent search", () => {
  it("combines case-insensitive name, title and role words with status and built-in filters", () => {
    const alpha = makeAgent({ id: "alpha", name: "Alpha", role: "engineer", status: "active", title: "Connector engineer" });
    const beta = makeAgent({ id: "beta", name: "Beta", role: "designer", status: "paused", title: "Design reviewer" });
    const hidden = makeAgent({ id: "hidden", name: "Beta", status: "terminated" });
    const agents = [alpha, beta, hidden];
    expect(filterAgents(agents, "all", new Set(), " BETA   design ")).toEqual([beta]);
    expect(filterAgents(agents, "active", new Set(), "beta")).toEqual([]);
    expect(filterAgents(agents, "paused", new Set(), "reviewer")).toEqual([beta]);
    expect(filterAgents(agents, "builtin", new Set([alpha.id]), "connector")).toEqual([alpha]);
    expect(filterAgents(agents, "all", new Set(), "   ")).toEqual([alpha, beta]);
  });

  it("retains the hierarchy above a matching report and promotes reports of hidden agents", () => {
    const child = { id: "child", name: "Designer", role: "designer", status: "paused", reports: [] };
    const root = { id: "root", name: "CEO", role: "ceo", status: "active", reports: [child] };
    expect(filterOrgTree([root], "all", new Set(), new Set([child.id]))).toEqual([root]);
    expect(filterOrgTree([root], "all", new Set(), new Set())).toEqual([]);
    expect(filterOrgTree([{ ...root, status: "terminated" }], "all", new Set(), new Set([child.id]))).toEqual([child]);
  });
});
function renderAgentsView(root: ReturnType<typeof createRoot> | null, queryClient: QueryClient) {
  root!.render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider><ToastProvider>
        <Agents />
      </ToastProvider></TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("Agents", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot> | null;
  let queryClient: QueryClient;

  beforeEach(() => {
    mockRouterState.pathname = "/agents/all";
    mockRouterState.navigate.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        adapterConfig: { model: "gpt-5.4" },
        // Old enough that relativeTime() falls back to an absolute date string.
        lastHeartbeatAt: new Date("2026-01-15T00:00:00Z"),
      }),
    ]);
    mockAgentsApi.org.mockResolvedValue([
      {
        id: "agent-1",
        name: "Alpha",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ]);
    mockBuiltInAgentsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({ id: "env-daytona" }),
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(environmentCapabilities);
    mockInstanceSettingsApi.get.mockResolvedValue(makeInstanceSettings());
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: {},
      agentMemberships: {},
      updatedAt: null,
    });
    mockResourceMembershipsApi.updateAgent.mockResolvedValue({
      resourceType: "agent",
      resourceId: "agent-1",
      state: "left",
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    mockSidebarState.isMobile = false;
  });

  afterEach(async () => {
    const currentRoot = root;
    if (currentRoot) {
      await act(async () => {
        currentRoot.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shares harness filters across views while keeping dimmed chart cards navigable and stationary", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "alpha", name: "Alpha", adapterType: "codex_local" }),
      makeAgent({ id: "beta", name: "Beta", adapterType: "claude_local" }),
    ]);
    mockAgentsApi.org.mockResolvedValue([
      { id: "alpha", name: "Alpha", role: "engineer", status: "active", reports: [
        { id: "beta", name: "Beta", role: "engineer", status: "active", reports: [] },
      ] },
    ]);
    root = createRoot(container);
    await reactAct(async () => renderAgentsView(root, queryClient));
    await flushReact();
    await flushReact();
    const filterButton = container.querySelector<HTMLButtonElement>('[aria-label="Filter agents"]')!;
    expect(filterButton.closest('[aria-label="Agents controls"]')).not.toBeNull();
    expect(container.querySelector("thead")?.textContent).toContain("2 agents");
    await reactAct(() => filterButton.click());
    await flushReact();
    const harnessOption = document.querySelector<HTMLSelectElement>('select[aria-label="Harness"]')!;
    await reactAct(() => { harnessOption.value = "codex_local"; harnessOption.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(container.querySelector("thead")?.textContent).toContain("1 agent");
    await reactAct(() => filterButton.click());
    await reactAct(() => container.querySelector<HTMLButtonElement>('[aria-label="Org chart view"]')!.click());
    await flushReact();
    await flushReact();
    const cards = [...container.querySelectorAll<HTMLElement>("[data-org-card]")];
    expect(cards).toHaveLength(2);
    const alpha = cards.find(card => card.textContent?.includes("Alpha"))!;
    const beta = cards.find(card => card.textContent?.includes("Beta"))!;
    expect(alpha.dataset.filterMatch).toBe("true");
    expect(beta.dataset.filterMatch).toBe("false");
    const position = beta.style.cssText;
    const transform = container.querySelector<HTMLElement>('[data-testid="org-chart-card-layer"]')!.style.transform;
    await reactAct(() => beta.click());
    expect(mockRouterState.navigate).toHaveBeenCalled();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!;
    await reactAct(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "no match");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-org-card][data-filter-match="false"]')).toHaveLength(2);
    expect(beta.style.cssText).toBe(position);
    expect(container.querySelector<HTMLElement>('[data-testid="org-chart-card-layer"]')!.style.transform).toBe(transform);
    await reactAct(() => container.querySelector<HTMLButtonElement>('[aria-label="Clear search"]')!.click());
    await reactAct(() => filterButton.click());
    await flushReact();
    await reactAct(() => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Agent filter choices"] button')].find(button => button.textContent === "Clear filters")!.click());
    expect(container.querySelectorAll('[data-org-card][data-filter-match="false"]')).toHaveLength(0);
  });

  it("filters the rendered roster and clears search without changing its status route", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "alpha", name: "Alpha", role: "engineer" }),
      makeAgent({ id: "beta", name: "Beta", role: "designer" }),
    ]);
    root = createRoot(container);
    await act(async () => root!.render(<QueryClientProvider client={queryClient}><TooltipProvider><ToastProvider><Agents /></ToastProvider></TooltipProvider></QueryClientProvider>));
    await flushReact();
    await flushReact();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "beta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(findAgentRow(container, "Beta")).not.toBeNull();
    expect(findAgentRow(container, "Alpha")).toBeNull();
    await act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Clear search"]')!.click());
    expect(findAgentRow(container, "Alpha")).not.toBeNull();
    expect(mockRouterState.navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["streamlined", Agents],
    ["production", ProductionAgents],
  ] as const)("%s: combines metadata filters, keeps hidden selections, and retains org ancestors", async (_mode, AgentList) => {
    const agents = [
      makeAgent({ id: "manager", name: "Manager", adapterType: "process" }),
      makeAgent({ id: "alpha", name: "Alpha", status: "idle", adapterConfig: { model: "custom-model" }, reportsTo: "manager" }),
      makeAgent({ id: "beta", name: "Beta", status: "paused", adapterType: "claude_local", adapterConfig: { model: "other-model" } }),
    ];
    mockAgentsApi.list.mockResolvedValue(agents);
    mockAgentsApi.org.mockResolvedValue([
      { ...agents[0], reports: [{ ...agents[1], reports: [] }] }, { ...agents[2], reports: [] },
    ]);
    root = createRoot(container);
    await act(async () => root!.render(<QueryClientProvider client={queryClient}><TooltipProvider><ToastProvider><AgentList /></ToastProvider></TooltipProvider></QueryClientProvider>));
    await flushReact();
    await flushReact();
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="List view"]')!.click());
    await flushReact();
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Select Beta"]')!.click());
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Filter agents"]')!.click());
    const select = async (field: string, value: string) => {
      const control = document.querySelector<HTMLSelectElement>(`select[aria-label="${field}"]`)!;
      expect(control).not.toBeNull();
      await act(() => { control.value = value; control.dispatchEvent(new Event("change", { bubbles: true })); });
    };
    await select("Model", "model:custom-model");
    await select("Status", "idle");
    await select("Harness", "codex_local");
    await select("Connection", "local");
    expect(container.querySelector("tbody")?.textContent).toContain("Alpha");
    expect(container.querySelector("tbody")?.textContent).not.toContain("Beta");
    expect(container.querySelector("tbody")?.textContent).not.toContain("Manager");
    expect(document.querySelector('[aria-label="Bulk actions"]')?.textContent).toContain("1 hidden by filters");
    expect(container.querySelector('[aria-label="Filter agents"]')?.textContent).toBe("4");
    expect(container.querySelector(AgentList === Agents ? "thead" : '[aria-label="Agent filters"]')?.textContent).toContain("1 agent");
    await act(() => { queryClient.setQueryData(queryKeys.agents.list("company-1"), agents.map(agent => agent.id === "alpha" ? { ...agent, adapterConfig: { model: "new-model" } } : agent)); });
    await flushReact();
    expect(document.querySelector<HTMLSelectElement>('select[aria-label="Model"]')?.selectedOptions[0].textContent).toBe("Previously selected model");
    expect(container.textContent).toContain("No agents match these filters.");
    await act(() => { queryClient.setQueryData(queryKeys.agents.list("company-1"), agents); });
    await flushReact();
    await select("Connection", "external");
    expect(container.textContent).toContain("No agents match these filters.");
    await select("Connection", "local");
    // Close the nonmodal popover before switching views.
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Filter agents"]')!.click());
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Org chart view"]')!.click());
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Manager");
    if (AgentList === Agents) {
      const beta = [...container.querySelectorAll<HTMLElement>("[data-org-card]")].find(card => card.textContent?.includes("Beta"))!;
      expect(beta.dataset.filterMatch).toBe("false");
    } else {
      expect(container.textContent).not.toContain("Beta");
    }
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Filter agents"]')!.click());
    await select("Status", "paused");
    if (AgentList === Agents) expect(container.querySelectorAll('[data-org-card][data-filter-match="true"]')).toHaveLength(0);
    else expect(container.textContent).toContain("No agents match");
    const clear = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Clear filters")!;
    await act(() => clear.click());
    expect(container.textContent).toContain("Beta");
    expect(container.querySelector('[aria-label="Filter agents"]')?.textContent).toBe("");
  });

  it("intersects metadata filters with search and keeps search when filters are cleared", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ id: "alpha", name: "Alpha", status: "idle" }),
      makeAgent({ id: "beta", name: "Beta", status: "paused" }),
    ]);
    root = createRoot(container);
    await act(async () => renderAgentsView(root, queryClient));
    await flushReact();
    await flushReact();
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search agents"]')!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "beta");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Filter agents"]')!.click());
    const status = document.querySelector<HTMLSelectElement>('select[aria-label="Status"]')!;
    await act(() => { status.value = "idle"; status.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(container.textContent).toContain("No agents match these filters.");
    await act(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Clear filters")!.click());
    expect(input.value).toBe("beta");
    expect(container.querySelector("tbody")?.textContent).toContain("Beta");
    expect(container.querySelector("tbody")?.textContent).not.toContain("Alpha");
  });

  it.each([
    ["streamlined", Agents],
    ["production", ProductionAgents],
  ] as const)("omits the action bar from %s agent list rows", async (_mode, AgentList) => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ name: "Alpha", status: "active" }),
      makeAgent({ id: "agent-paused", name: "Paused agent", status: "paused" }),
    ]);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider><ToastProvider>
            <AgentList />
          </ToastProvider></TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    const listToggle = container.querySelector<HTMLButtonElement>('button[aria-label="List view"]');
    await act(async () => { listToggle?.click(); });
    await flushReact();

    for (const name of ["Alpha", "Paused agent"]) {
      const row = findAgentRow(container, name);
      expect(row).not.toBeNull();
      expect(row?.getAttribute("href")).toMatch(/^\/agents\//);
      expect(row?.querySelector('button[aria-label^="Open actions for"]')).toBeNull();
      const buttons = Array.from(row?.querySelectorAll("button") ?? []).map((button) => button.textContent);
      expect(buttons).not.toEqual(expect.arrayContaining([expect.stringMatching(/Assign Task|Run Heartbeat|Run with provider trace|Pause|Resume/)]));
    }
  });

  it("shows the configured model beside the adapter on the all agents page", async () => {
    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("codex_local");
    expect(container.textContent).toContain("gpt-5.4");

    // The heartbeat cell must render on a single line so full dates like
    // "Apr 30, 2026" never wrap (PAP-85 defect #2).
    const heartbeatCell = container.querySelector('[title="Last heartbeat"]');
    expect(heartbeatCell).not.toBeNull();
    expect(heartbeatCell?.textContent).not.toContain("\n");
  });

  it("switches between the preserved list and the interactive org chart with icon buttons", async () => {
    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();

    const listToggle = container.querySelector<HTMLButtonElement>('button[aria-label="List view"]');
    const orgToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Org chart view"]');
    expect(listToggle?.getAttribute("aria-pressed")).toBe("true");
    expect(orgToggle?.getAttribute("aria-pressed")).toBe("false");
    expect(orgToggle?.querySelector(".lucide-network")).not.toBeNull();
    expect(orgToggle?.querySelector(".lucide-git-branch")).toBeNull();
    expect(container.querySelector('[data-testid="org-chart-viewport"]')).toBeNull();

    await act(async () => {
      orgToggle?.click();
    });
    await flushReact();
    await flushReact();

    expect(mockAgentsApi.org).toHaveBeenCalledWith("company-1");
    expect(orgToggle?.getAttribute("aria-pressed")).toBe("true");
    const orgViewport = container.querySelector('[data-testid="org-chart-viewport"]');
    expect(orgViewport).not.toBeNull();
    expect(orgViewport?.parentElement?.classList.contains("flex-1")).toBe(true);
    expect(orgViewport?.parentElement?.classList.contains("min-h-0")).toBe(true);
    expect(orgViewport?.parentElement?.classList.contains("h-(--sz-calc-38)")).toBe(false);
    expect(orgViewport?.parentElement?.parentElement?.classList.contains("min-h-0")).toBe(true);
    expect(container.querySelector('[aria-label="Zoom in"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Zoom out"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Fit chart to screen"]')).not.toBeNull();
    const controlsSlot = container.querySelector('[data-org-toolbar-controls]')!;
    expect(controlsSlot.getAttribute("data-visible")).toBe("true");
    expect(controlsSlot.hasAttribute("inert")).toBe(false);
    expect(controlsSlot.querySelector('[aria-label="Chart camera"]')).not.toBeNull();
    const cameraLayer = container.querySelector<HTMLElement>('[data-testid="org-chart-card-layer"]')!;
    const initialCamera = cameraLayer.style.transform;
    await act(async () => controlsSlot.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(cameraLayer.style.transform).not.toBe(initialCamera);
    await act(async () => controlsSlot.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
    expect(controlsSlot.textContent).not.toContain("Tasks");
    expect(controlsSlot.nextElementSibling?.textContent).toContain("New Agent");
    expect(orgViewport?.querySelector('[aria-label="Org chart controls"]')).toBeNull();

    await act(async () => {
      listToggle?.click();
    });
    await flushReact();
    expect(container.querySelector('[data-testid="org-chart-viewport"]')).toBeNull();
    expect(container.textContent).toContain("gpt-5.4");
    expect(container.querySelector('[data-org-toolbar-controls]')).toBe(controlsSlot);
    expect(controlsSlot.getAttribute("data-visible")).toBe("false");
    expect(controlsSlot.getAttribute("aria-hidden")).toBe("true");
    expect(controlsSlot.hasAttribute("inert")).toBe(true);
    await act(async () => orgToggle?.click());
    await flushReact();
    expect(container.querySelector('[data-org-toolbar-controls]')).toBe(controlsSlot);
    expect(controlsSlot.getAttribute("data-visible")).toBe("true");
    expect(controlsSlot.getAttribute("aria-hidden")).toBe("false");
    expect(controlsSlot.hasAttribute("inert")).toBe(false);
  });

  it("gives mobile agent names the full row width after the leading status indicator", async () => {
    mockSidebarState.isMobile = true;
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: {},
      agentMemberships: {
        "agent-mobile": "left",
      },
      starredProjectIds: [],
      starredAgentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-mobile",
        name: "Paperclip Engineer With A Much Longer Display Name",
        title: "Software Engineer With A Much Longer Specialty Title",
        urlKey: "paperclip-engineer-long",
      }),
    ]);

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    const row = findAgentRow(container, "Paperclip Engineer With A Much Longer Display Name");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".sm\\:hidden")).toBeNull();
    expect(row?.closest("tr")?.textContent).toContain("idle");

    expect(row?.classList.contains("text-foreground/55")).toBe(false);
    expect(row?.classList.contains("sm:text-foreground/55")).toBe(false);
    const name = row?.querySelector("span[title='Paperclip Engineer With A Much Longer Display Name']");
    const subtitle = Array.from(row?.querySelectorAll("p") ?? []).find((node) =>
      node.textContent?.includes("Software Engineer With A Much Longer Specialty Title"),
    );
    expect(name?.classList.contains("truncate")).toBe(true);
    expect(subtitle).toBeDefined();
    expect(subtitle?.classList.contains("truncate")).toBe(true);
    const actions = row?.querySelector('button[aria-label="Open actions for Paperclip Engineer With A Much Longer Display Name"]');
    expect(actions).toBeNull();
    expect(row?.textContent).not.toContain("Assign Task");
    expect(row?.textContent).not.toContain("Run Heartbeat");
    expect(row?.textContent).not.toContain("Run with provider trace");
    expect(row?.textContent).not.toContain("Pause");
  });


  it("shows effective environment and sandbox provider beside agents", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        defaultEnvironmentId: "env-daytona",
      }),
    ]);
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({
        id: "env-local",
        name: "Local",
        driver: "local",
        config: {},
      }),
      makeEnvironment({ id: "env-daytona" }),
    ]);

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Daytona Sandbox");
    expect(container.textContent).toContain("Daytona sandbox provider");
  });

  it("uses configured names for local-driver environments", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        defaultEnvironmentId: "env-local",
      }),
    ]);
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({
        id: "env-local",
        name: "Dev Laptop",
        driver: "local",
        config: {},
      }),
      makeEnvironment({ id: "env-daytona" }),
    ]);

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Dev Laptop");
    expect(container.textContent).toContain("Paperclip host");
  });

  it("reserves the environment column while environment metadata is loading", async () => {
    let resolveEnvironments: (environments: Environment[]) => void = () => {};
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        defaultEnvironmentId: "env-daytona",
      }),
    ]);
    mockEnvironmentsApi.list.mockReturnValue(new Promise((resolve) => {
      resolveEnvironments = resolve;
    }));

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Loading environment");

    await act(async () => {
      resolveEnvironments([
        makeEnvironment({
          id: "env-local",
          name: "Local",
          driver: "local",
          config: {},
        }),
        makeEnvironment({ id: "env-daytona" }),
      ]);
    });
    await flushReact();

    expect(container.textContent).toContain("Daytona Sandbox");
    expect(container.textContent).not.toContain("Loading environment");
  });

  it("hides the environment column when there is only one configured environment", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        defaultEnvironmentId: "env-daytona",
      }),
    ]);

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Daytona Sandbox");
    expect(container.textContent).not.toContain("Daytona sandbox provider");
  });

  it("hides the environment column when environments are experimentally disabled", async () => {
    mockInstanceSettingsApi.get.mockResolvedValue(makeInstanceSettings({ enableEnvironments: false }));
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-local",
        name: "Local Agent",
        urlKey: "local-agent",
        defaultEnvironmentId: null,
      }),
      makeAgent({
        id: "agent-sandbox",
        name: "Sandbox Agent",
        urlKey: "sandbox-agent",
        defaultEnvironmentId: "env-daytona",
      }),
    ]);
    mockAgentsApi.org.mockResolvedValue([
      {
        id: "agent-local",
        name: "Local Agent",
        role: "engineer",
        status: "active",
        reports: [],
      },
      {
        id: "agent-sandbox",
        name: "Sandbox Agent",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ]);
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({
        id: "env-local",
        name: "Local",
        driver: "local",
        config: {},
      }),
      makeEnvironment({ id: "env-daytona" }),
    ]);

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).not.toContain("Daytona Sandbox");
    expect(container.textContent).not.toContain("Daytona sandbox provider");
    expect(mockEnvironmentsApi.list).not.toHaveBeenCalled();
    expect(mockEnvironmentsApi.capabilities).not.toHaveBeenCalled();
  });

  it("uses the instance default environment unless the agent overrides it", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "agent-fallback",
        name: "Fallback Agent",
        urlKey: "fallback-agent",
        defaultEnvironmentId: null,
      }),
      makeAgent({
        id: "agent-override",
        name: "Override Agent",
        urlKey: "override-agent",
        defaultEnvironmentId: "env-override",
      }),
    ]);
    mockAgentsApi.org.mockResolvedValue([
      {
        id: "agent-fallback",
        name: "Fallback Agent",
        role: "engineer",
        status: "active",
        reports: [],
      },
      {
        id: "agent-override",
        name: "Override Agent",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ]);
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({
        id: "env-default",
        name: "Instance Default",
        config: { provider: "daytona" },
      }),
      makeEnvironment({
        id: "env-override",
        name: "Agent Override",
        config: { provider: "daytona" },
      }),
    ]);
    mockInstanceSettingsApi.get.mockResolvedValue(makeInstanceSettings({ defaultEnvironmentId: "env-default" }));

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    const fallbackRow = findAgentRow(container, "Fallback Agent");
    const overrideRow = findAgentRow(container, "Override Agent");
    expect(fallbackRow?.textContent).toContain("Instance Default");
    expect(overrideRow?.textContent).toContain("Agent Override");
    expect(overrideRow?.textContent).not.toContain("Instance Default");
  });

  it("falls back to the raw sandbox provider config when capabilities omit a display name", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        defaultEnvironmentId: "env-custom",
      }),
    ]);
    mockEnvironmentsApi.list.mockResolvedValue([
      makeEnvironment({
        id: "env-local",
        name: "Local",
        driver: "local",
        config: {},
      }),
      makeEnvironment({
        id: "env-custom",
        name: "Custom Sandbox",
        config: { provider: "acme_sandbox" },
      }),
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue({
      ...environmentCapabilities,
      sandboxProviders: {},
    });

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Custom Sandbox");
    expect(container.textContent).toContain("acme_sandbox sandbox provider");
  });

  it("does not show environment filter or grouping controls yet", async () => {
    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('select[aria-label="Filter by environment"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Group agents"]')).toBeNull();
  });

  it.each([
    { mode: "streamlined", AgentList: Agents },
    { mode: "production", AgentList: ProductionAgents },
  ].flatMap(layout => ["active", "paused", "error", "builtin"].map(tab => ({ ...layout, tab }))))("redirects legacy /agents/$tab to the full $mode roster", async ({ tab, AgentList }) => {
    mockRouterState.pathname = `/agents/${tab}`;
    mockSidebarState.isMobile = true;
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({}), makeAgent({ id: "paused-agent", name: "Paused", status: "paused" }),
      makeAgent({ id: "error-agent", name: "Error", status: "error" }),
    ]);

    root = createRoot(container);
    await act(async () => {
      root!.render(<QueryClientProvider client={queryClient}><TooltipProvider><ToastProvider><AgentList /></ToastProvider></TooltipProvider></QueryClientProvider>);
    });
    await flushReact();
    await flushReact();

    expect(mockBuiltInAgentsApi.list).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Built-in");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(mockRouterState.navigate).toHaveBeenCalledWith("/agents/all", { replace: true });
  });

  it("redirects the legacy built-in URL to all agents while loading enabled built-in metadata", async () => {
    mockRouterState.pathname = "/agents/builtin";
    mockInstanceSettingsApi.get.mockResolvedValue(makeInstanceSettings({ enableBuiltInAgents: true }));
    const builtInAgent = makeAgent({
      id: "built-in-agent",
      name: "Briefs Agent",
      urlKey: "briefs-agent",
    });
    const regularAgent = makeAgent({
      id: "regular-agent",
      name: "Regular Agent",
      urlKey: "regular-agent",
    });
    mockAgentsApi.list.mockResolvedValue([builtInAgent, regularAgent]);
    mockAgentsApi.org.mockResolvedValue([
      {
        id: "built-in-agent",
        name: "Briefs Agent",
        role: "engineer",
        status: "active",
        reports: [],
      },
      {
        id: "regular-agent",
        name: "Regular Agent",
        role: "engineer",
        status: "active",
        reports: [],
      },
    ]);
    mockBuiltInAgentsApi.list.mockResolvedValue([
      makeBuiltInAgentState({ agentId: "built-in-agent", agent: builtInAgent }),
    ]);

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(mockBuiltInAgentsApi.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Briefs Agent");
    expect(container.textContent).toContain("Regular Agent");
    expect(container.querySelector('[title="Ships with Paperclip"]')).toBeNull();
    expect(mockRouterState.navigate).toHaveBeenCalledWith("/agents/all", { replace: true });
  });

  it("selects visible agents without navigating and exposes the harness edit action", async () => {
    root = createRoot(container);
    await act(async () => { renderAgentsView(root, queryClient); });
    await flushReact();
    await flushReact();
    const checkbox = container.querySelector<HTMLButtonElement>('[aria-label="Select Alpha"]');
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox!.click(); });
    expect(document.querySelector('[aria-label="Bulk actions"]')?.textContent).toContain("1 selected");
    expect(document.querySelector('[aria-label="Bulk actions"]')?.textContent).toContain("Edit connection & model");
    expect(mockRouterState.navigate).not.toHaveBeenCalled();
    expect(Array.from(container.querySelectorAll("th")).map(cell => cell.textContent)).toEqual(["", "1 agent", "Chat", "Status", "Harness", "Default model", "Connection"]);
  });

  it.each([
    ["streamlined", Agents],
    ["production", ProductionAgents],
  ] as const)("omits star and leave/join actions from %s agent index list and org views", async (_mode, AgentList) => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider><ToastProvider>
            <AgentList />
          </ToastProvider></TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // Explicitly select the list view and assert the row renders there.
    const listToggle = container.querySelector<HTMLButtonElement>('button[aria-label="List view"]');
    expect(listToggle).not.toBeNull();
    await act(async () => {
      listToggle!.click();
    });
    await flushReact();
    const listRow = findAgentRow(container, "Alpha");
    expect(listRow).not.toBeNull();
    expect(container.querySelector('[aria-label="Leave Alpha"]')).toBeNull();
    expect(container.querySelector('[aria-label="Join Alpha"]')).toBeNull();
    expect(container.querySelector('[aria-label="Star Alpha"]')).toBeNull();

    // Explicitly select the org view and assert no membership actions there.
    const orgToggle = container.querySelector<HTMLButtonElement>('button[aria-label="Org chart view"]');
    expect(orgToggle).not.toBeNull();
    await act(async () => {
      orgToggle!.click();
    });
    await flushReact();
    await flushReact();
    expect(container.textContent).toContain("Alpha");
    expect(container.querySelector('[aria-label="Leave Alpha"]')).toBeNull();
    expect(container.querySelector('[aria-label="Join Alpha"]')).toBeNull();
    expect(container.querySelector('[aria-label="Star Alpha"]')).toBeNull();
  });

  it.each([
    { mode: "streamlined", AgentList: Agents, isMobile: false },
    { mode: "streamlined", AgentList: Agents, isMobile: true },
    { mode: "production", AgentList: ProductionAgents, isMobile: false },
    { mode: "production", AgentList: ProductionAgents, isMobile: true },
  ])("keeps paused and left-membership agent names readable in $mode (mobile: $isMobile)", async ({ AgentList, isMobile }) => {
    mockSidebarState.isMobile = isMobile;
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ status: "paused", pausedAt: new Date("2026-01-02T00:00:00Z") }),
    ]);
    mockResourceMembershipsApi.listMine.mockResolvedValue({
      projectMemberships: {},
      agentMemberships: {
        "agent-1": "left",
      },
      starredProjectIds: [],
      starredAgentIds: [],
      projectStarredAt: {},
      agentStarredAt: {},
      updatedAt: new Date("2026-01-02T00:00:00Z"),
    });

    root = createRoot(container);
    await act(async () => {
      root!.render(<QueryClientProvider client={queryClient}><TooltipProvider><ToastProvider><AgentList /></ToastProvider></TooltipProvider></QueryClientProvider>);
    });
    await flushReact();
    await flushReact();
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="List view"]')?.click(); });
    await flushReact();

    const row = findAgentRow(container, "Alpha");
    expect(row).not.toBeNull();
    expect(row?.classList.contains("text-foreground/55")).toBe(false);
    expect(row?.classList.contains("sm:text-foreground/55")).toBe(false);
    expect(row?.classList.contains("opacity-50")).toBe(false);
    expect(row?.closest("tr")?.textContent).toContain("paused");
  });

  it("keeps invalid-org-chain agents visible with a warning marker", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ orgChainHealth: invalidOrgChainHealth }),
    ]);

    root = createRoot(container);
    await act(async () => {
      renderAgentsView(root, queryClient);
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Alpha");
    expect(container.querySelector('[aria-label="Invalid reporting chain"]')).not.toBeNull();
  });

  describe("disconnect handling", () => {
    it.each([
      ["streamlined", Agents],
      ["production", ProductionAgents],
    ] as const)("%s: keeps a loaded list on screen when a refetch fails transiently", async (_mode, AgentList) => {
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <TooltipProvider><ToastProvider>
              <AgentList />
            </ToastProvider></TooltipProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();
      expect(container.textContent).toContain("Alpha");

      // A refetch during a deploy fails: the cached roster stays, no error UI.
      mockAgentsApi.list.mockRejectedValueOnce(
        new ApiError("Paperclip is restarting.", 503, { error: "tenant_app_unavailable" }),
      );
      await act(async () => {
        await queryClient.invalidateQueries({ refetchType: "active" });
      });
      await flushReact();

      expect(container.textContent).toContain("Alpha");
      expect(container.querySelector('[data-query-view="error"]')).toBeNull();
      expect(container.textContent).not.toContain("tenant_app_unavailable");
    });

    it.each([
      ["streamlined", Agents],
      ["production", ProductionAgents],
    ] as const)("%s: shows readable copy with Retry on a real failure before the first load", async (_mode, AgentList) => {
      mockAgentsApi.list.mockReset();
      mockAgentsApi.list.mockRejectedValue(new ApiError("boom_stack_trace", 500, { error: "boom_stack_trace" }));
      root = createRoot(container);
      await act(async () => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <TooltipProvider><ToastProvider>
              <AgentList />
            </ToastProvider></TooltipProvider>
          </QueryClientProvider>,
        );
      });
      await flushReact();
      await flushReact();

      const alert = container.querySelector('[data-query-view="error"]');
      expect(alert).not.toBeNull();
      expect(alert?.textContent).toContain("Couldn't load agents");
      expect(alert?.textContent).not.toContain("boom_stack_trace");
      expect(alert?.querySelector("button")?.textContent).toContain("Retry");
    });

    it.each([
      ["streamlined", Agents],
      ["production", ProductionAgents],
    ] as const)("%s: shows the skeleton, not an empty roster, when the first load is paused on an outage", async (_mode, AgentList) => {
      // Paused queries report isLoading=false, so gating on it alone would
      // render the empty roster during an outage; the view state must win.
      mockAgentsApi.list.mockReset();
      mockAgentsApi.list.mockReturnValue(new Promise(() => {}));
      onlineManager.setOnline(false);
      try {
        root = createRoot(container);
        await act(async () => {
          root!.render(
            <QueryClientProvider client={queryClient}>
              <TooltipProvider><ToastProvider>
                <AgentList />
              </ToastProvider></TooltipProvider>
            </QueryClientProvider>,
          );
        });
        await flushReact();

        expect(container.textContent).not.toContain("Create your first agent");
        expect(container.querySelector('[data-query-view="error"]')).toBeNull();
        expect(findAgentRow(container, "Alpha")).toBeNull();
      } finally {
        onlineManager.setOnline(true);
      }
    });
  });
});
