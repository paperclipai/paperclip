// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Environment, EnvironmentCapabilities } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import type { BuiltInAgentState } from "../api/builtInAgents";
import { Agents } from "./Agents";
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

vi.mock("../adapters/adapter-display-registry", () => ({
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
      keyboardShortcuts: true,
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
      enableConferenceRoomChat: false,
      enableTaskWatchdogs: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: false,
      enableCloudSync: false,
      enableExternalObjects: false,
      enableBuiltInAgents,
      autoRestartDevServerWhenIdle: false,
      enableIssueGraphLivenessAutoRecovery: false,
      issueGraphLivenessAutoRecoveryLookbackHours: 24,
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

  it("shows the configured model beside the adapter on the all agents page", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("codex_local");
    expect(container.textContent).toContain("gpt-5.4");

    // The heartbeat cell must render on a single line so full dates like
    // "Apr 30, 2026" never wrap (PAP-85 defect #2).
    const heartbeatCell = container.querySelector(".whitespace-nowrap.w-24");
    expect(heartbeatCell).not.toBeNull();
    expect(heartbeatCell?.textContent).not.toContain("\n");
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const row = findAgentRow(container, "Paperclip Engineer With A Much Longer Display Name");
    expect(row).not.toBeNull();
    expect(row?.querySelector(".sm\\:hidden")).toBeNull();
    expect(row?.querySelector(".hidden.sm\\:flex")).not.toBeNull();
    expect(row?.querySelector(".flex-1.hidden.xl\\:block")).not.toBeNull();
    expect(row?.classList.contains("text-foreground/55")).toBe(false);
    expect(row?.classList.contains("sm:text-foreground/55")).toBe(true);
    const name = row?.querySelector("span[title='Paperclip Engineer With A Much Longer Display Name']");
    const subtitle = Array.from(row?.querySelectorAll("p") ?? []).find((node) =>
      node.textContent?.includes("Software Engineer With A Much Longer Specialty Title"),
    );
    expect(name?.classList.contains("whitespace-normal")).toBe(true);
    expect(name?.classList.contains("break-words")).toBe(true);
    expect(name?.classList.contains("xl:truncate")).toBe(true);
    expect(name?.classList.contains("xl:whitespace-nowrap")).toBe(true);
    expect(name?.classList.contains("truncate")).toBe(false);
    expect(subtitle).toBeDefined();
    expect(subtitle?.classList.contains("whitespace-normal")).toBe(true);
    expect(subtitle?.classList.contains("break-words")).toBe(true);
    expect(subtitle?.classList.contains("xl:truncate")).toBe(true);
    expect(subtitle?.classList.contains("xl:whitespace-nowrap")).toBe(true);
    expect(subtitle?.classList.contains("truncate")).toBe(false);
  });

  it("uses the built-in agents route segment as the built-in filter", async () => {
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("1 agent");
    expect(container.textContent).toContain("Briefs Agent");
    expect(container.textContent).not.toContain("Regular Agent");
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Custom Sandbox");
    expect(container.textContent).toContain("acme_sandbox sandbox provider");
  });

  it("does not show environment filter or grouping controls yet", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.querySelector('select[aria-label="Filter by environment"]')).toBeNull();
    expect(container.querySelector('select[aria-label="Group agents"]')).toBeNull();
  });

  it("hides built-in agent surfaces while the experimental flag is disabled", async () => {
    mockRouterState.pathname = "/agents/builtin";

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockBuiltInAgentsApi.list).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Built-in");
    expect(mockRouterState.navigate).toHaveBeenCalledWith("/agents/all", { replace: true });
  });

  it("shows and filters built-in agents when the experimental flag is enabled", async () => {
    mockRouterState.pathname = "/agents/builtin";
    mockInstanceSettingsApi.get.mockResolvedValue(makeInstanceSettings({ enableBuiltInAgents: true }));
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({
        id: "built-in-agent",
        name: "Briefs Agent",
        urlKey: "briefs-agent",
      }),
      makeAgent({
        id: "regular-agent",
        name: "Regular Agent",
        urlKey: "regular-agent",
      }),
    ]);
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
      makeBuiltInAgentState({ agentId: "built-in-agent" }),
    ]);

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(mockBuiltInAgentsApi.list).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("Built-in");
    expect(container.textContent).toContain("Briefs Agent");
    expect(container.textContent).not.toContain("Regular Agent");
    expect(container.querySelector('[title="Ships with Paperclip"]')).toBeNull();
    expect(mockRouterState.navigate).not.toHaveBeenCalledWith("/agents/all", { replace: true });
  });

  it("gives list-view rows a fixed-width title so meta columns align (PAP-86)", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // Switch from the default org view to the list view.
    const listToggle = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.querySelector("svg.lucide-list"),
    );
    expect(listToggle).toBeDefined();
    await act(async () => {
      listToggle!.click();
    });
    await flushReact();

    // The title cell carries a constant width at xl (`xl:w-56`), not a
    // content-sized `min-w-(--sz-7rem)`, so the `meta` group starts at the same
    // x on every row and the model + timestamp columns line up vertically.
    // Below xl the meta columns are hidden and the title flexes (`flex-1`)
    // instead, so the shrink-0 trailing actions can't squeeze the agent name
    // to zero width on mobile.
    const titleCell = container.querySelector(".xl\\:w-56");
    expect(titleCell).not.toBeNull();
    expect(titleCell?.textContent).toContain("Alpha");
    expect(titleCell?.classList.contains("flex-1")).toBe(true);
    expect(container.querySelector(".min-w-\\(--sz-7rem\\)")).toBeNull();
  });

  it("keeps row membership actions reachable while hiding star actions on mobile", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    // Org view (default).
    const orgAction = container.querySelector('[aria-label="Leave Alpha"]');
    const orgStar = container.querySelector('[aria-label="Star Alpha"]');
    expect(orgAction).not.toBeNull();
    expect(orgStar).not.toBeNull();
    expect(orgAction?.closest(".hidden")).toBeNull();
    expect(orgStar?.closest(".hidden")).not.toBeNull();

    // List view.
    const listToggle = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.querySelector("svg.lucide-list"),
    );
    await act(async () => {
      listToggle!.click();
    });
    await flushReact();

    const listAction = container.querySelector('[aria-label="Leave Alpha"]');
    const listStar = container.querySelector('[aria-label="Star Alpha"]');
    expect(listAction).not.toBeNull();
    expect(listStar).not.toBeNull();
    expect(listAction?.closest(".hidden")).toBeNull();
    expect(listStar?.closest(".hidden")).not.toBeNull();
  });

  it("does not dim left-membership agent names on mobile", async () => {
    mockSidebarState.isMobile = true;
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
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const row = findAgentRow(container, "Alpha");
    expect(row).not.toBeNull();
    expect(row?.classList.contains("text-foreground/55")).toBe(false);
    expect(row?.classList.contains("sm:text-foreground/55")).toBe(true);
  });

  it("keeps invalid-org-chain agents visible with a warning marker", async () => {
    mockAgentsApi.list.mockResolvedValue([
      makeAgent({ orgChainHealth: invalidOrgChainHealth }),
    ]);

    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <Agents />
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Alpha");
    expect(container.querySelector('[aria-label="Invalid reporting chain"]')).not.toBeNull();
  });
});
