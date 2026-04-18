// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkAgentControls, buildBulkAgentPlan, buildFlowBottleneckSummary } from "./BulkAgentControls";

const toastState = vi.hoisted(() => ({
  pushToast: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  pause: vi.fn(),
  resume: vi.fn(),
  update: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getAutomationPreflight: vi.fn(),
  syncDashboardRepo: vi.fn(),
}));

const mockCostsApi = vi.hoisted(() => ({
  quotaWindows: vi.fn(),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => toastState,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/costs", () => ({
  costsApi: mockCostsApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent One",
    role: "engineer",
    title: null,
    icon: "bot",
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: undefined,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    urlKey: "agent-one",
    ...overrides,
  } as Agent;
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue One",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: "BLA-1",
    originKind: null,
    originId: null,
    originRunId: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionPolicy: null,
    executionState: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    activeRun: null,
    lastActivityAt: new Date("2026-04-01T00:00:00.000Z"),
    ...overrides,
  } as Issue;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 25) {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }

  throw lastError;
}

function clickText(container: HTMLElement, text: string) {
  const element = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  );
  if (!element) throw new Error(`Button not found: ${text}`);
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function clickDialogAction(text: string) {
  const dialog = document.body.querySelector("[data-slot='dialog-content']");
  if (!(dialog instanceof HTMLElement)) {
    throw new Error("Dialog not found");
  }
  clickText(dialog, text);
}

function renderWithQueryClient(node: ReactNode, container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        {node}
      </QueryClientProvider>,
    );
  });

  return { root };
}

describe("BulkAgentControls", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    toastState.pushToast.mockReset();
    mockAgentsApi.pause.mockReset();
    mockAgentsApi.resume.mockReset();
    mockAgentsApi.update.mockReset();
    mockIssuesApi.list.mockReset();
    mockInstanceSettingsApi.getAutomationPreflight.mockReset();
    mockInstanceSettingsApi.syncDashboardRepo.mockReset();
    mockAgentsApi.pause.mockResolvedValue(undefined);
    mockAgentsApi.resume.mockResolvedValue(undefined);
    mockAgentsApi.update.mockResolvedValue(undefined);
    mockIssuesApi.list.mockResolvedValue([]);
    mockInstanceSettingsApi.getAutomationPreflight.mockResolvedValue({
      checkedAt: "2026-04-13T06:50:00.000Z",
      state: "healthy",
      headline: "Automation Preflight",
      detail: "Dashboard-owned GitHub, Claude, and Codex auth are healthy.",
      prAutomationDegraded: false,
      checks: [
        {
          id: "github",
          label: "GitHub",
          state: "healthy",
          detail: "GitHub auth is healthy for usernamedJ.",
          impacts: ["PR creation"],
          lastUpdatedAt: "2026-04-13T06:47:34.000Z",
        },
        {
          id: "claude",
          label: "Claude",
          state: "healthy",
          detail: "Claude auth is configured in the dashboard home.",
          impacts: ["Claude-run agent wakes"],
          lastUpdatedAt: "2026-04-09T02:48:40.000Z",
        },
        {
          id: "codex",
          label: "Codex",
          state: "healthy",
          detail: "Codex auth is configured in the dashboard home.",
          impacts: ["Codex-run agent wakes"],
          lastUpdatedAt: "2026-04-05T11:37:44.000Z",
        },
      ],
    });
    mockInstanceSettingsApi.syncDashboardRepo.mockResolvedValue({
      sourceRepo: "/Users/jeffrysoto/paperclip",
      targetRepo: "/Users/jeffrysoto/.blackcore/dashboard-home/paperclip",
      sourceHead: "8b74b382",
      targetHead: "8b74b382",
      restartRecommended: true,
      syncedAt: "2026-04-13T05:20:00.000Z",
      stdout: "",
      stderr: "",
    });
    mockCostsApi.quotaWindows.mockReset();
    mockCostsApi.quotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        ok: true,
        source: "claude-cli",
        windows: [{ label: "Current session", usedPercent: 12, resetsAt: null, valueLabel: null }],
      },
      {
        provider: "openai",
        ok: true,
        source: "codex-rpc",
        windows: [{ label: "5h limit", usedPercent: 35, resetsAt: null, valueLabel: null }],
      },
    ]);
  });

  afterEach(() => {
    container.remove();
  });

  it("skips manually paused lanes by default on start", () => {
    const plan = buildBulkAgentPlan(
      [
        createAgent({ id: "paused-manual", status: "paused", pauseReason: "manual", name: "Manual Hold" }),
        createAgent({ id: "paused-auto", status: "paused", pauseReason: "budget", name: "Budget Pause" }),
        createAgent({ id: "error-1", status: "error", name: "Errored Agent" }),
      ],
      "start",
      false,
    );

    expect(plan.targets.map((target) => `${target.agent.id}:${target.operation}`)).toEqual([
      "paused-auto:resume",
    ]);
    expect(plan.skippedManualPaused).toBe(1);
  });

  it("starts only paused agents when confirmed", async () => {
    const agents = [
      createAgent({ id: "paused-auto", status: "paused", pauseReason: "budget", name: "Budget Pause" }),
      createAgent({ id: "error-1", status: "error", name: "Errored Agent" }),
      createAgent({ id: "running-1", status: "running", name: "Running Agent" }),
      createAgent({ id: "paused-manual", status: "paused", pauseReason: "manual", name: "Manual Hold" }),
    ];

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={agents} />,
      container,
    );

    clickText(container, "Start All");
    await flush();
    clickDialogAction("Start All");

    await waitForAssertion(() => {
      expect(mockAgentsApi.resume).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.resume).toHaveBeenCalledWith("paused-auto", "company-1");
      expect(mockAgentsApi.update).not.toHaveBeenCalled();
      expect(mockAgentsApi.pause).not.toHaveBeenCalled();
      expect(toastState.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "success",
          title: "Start complete",
        }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("restarts only errored agents and leaves healthy work untouched", async () => {
    const agents = [
      createAgent({ id: "error-1", status: "error", name: "Errored Agent" }),
      createAgent({ id: "running-1", status: "running", name: "Running Agent" }),
      createAgent({ id: "idle-1", status: "idle", name: "Idle Agent" }),
    ];

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={agents} />,
      container,
    );

    clickText(container, "Restart All");
    await flush();
    clickDialogAction("Restart All");

    await waitForAssertion(() => {
      expect(mockAgentsApi.update).toHaveBeenCalledWith(
        "error-1",
        {
          status: "idle",
          pauseReason: null,
          pausedAt: null,
        },
        "company-1",
      );
      expect(mockAgentsApi.pause).not.toHaveBeenCalled();
      expect(mockAgentsApi.resume).not.toHaveBeenCalled();
      expect(toastState.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "success",
          title: "Restart complete",
        }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("skips process-adapter errors from restart and marks them as manual recovery", () => {
    const plan = buildBulkAgentPlan(
      [
        createAgent({ id: "process-error", status: "error", adapterType: "process", name: "Local Dev" }),
        createAgent({ id: "codex-error", status: "error", adapterType: "codex_local", name: "Recoverable Agent" }),
      ],
      "restart",
      false,
    );

    expect(plan.targets.map((target) => `${target.agent.id}:${target.operation}`)).toEqual([
      "codex-error:clearError",
    ]);
  });

  it("shows the assigned IT ticket for manual recovery agents", async () => {
    const agents = [
      createAgent({ id: "dev-agent", name: "Dev", status: "error", adapterType: "process", urlKey: "dev" }),
      createAgent({ id: "it-agent", name: "Senior Dev 1", status: "idle", adapterType: "codex_local" }),
    ];

    mockIssuesApi.list.mockResolvedValue([
      createIssue({
        id: "issue-dev-recovery",
        identifier: "BLA-271",
        title: "Dev process-lane recovery - restore local deterministic worker",
        description: "Manual recovery for Dev process-lane failure.",
        assigneeAgentId: "it-agent",
        status: "in_progress",
      }),
    ]);

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={agents} />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1");
      expect(mockCostsApi.quotaWindows).toHaveBeenCalledWith("company-1");
      expect(container.textContent).toContain("Dev needs manual recovery.");
      expect(container.textContent).toContain("Recovery assigned as an IT ticket");
      expect(container.textContent).toContain("BLA-271");
      expect(container.textContent).toContain("Senior Dev 1");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows the assigned IT ticket for recoverable errored agents too", async () => {
    const agents = [
      createAgent({ id: "sd2-agent", name: "Senior Dev 2", status: "error", adapterType: "codex_local", urlKey: "senior-dev-2" }),
      createAgent({ id: "it-agent", name: "Platform Reliability Engineer", status: "idle", adapterType: "codex_local" }),
    ];

    mockIssuesApi.list.mockResolvedValue([
      createIssue({
        id: "issue-sd2-recovery",
        identifier: "BLA-300",
        title: "Senior Dev 2 recovery follow-up",
        description: "Recovery assigned as IT follow-up for Senior Dev 2.",
        assigneeAgentId: "it-agent",
        status: "todo",
      }),
    ]);

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={agents} />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Senior Dev 2 needs recovery.");
      expect(container.textContent).toContain("Recovery assigned as an IT ticket");
      expect(container.textContent).toContain("BLA-300");
      expect(container.textContent).toContain("Platform Reliability Engineer");
    });

    act(() => {
      root.unmount();
    });
  });

  it("frees memory by pausing only idle agents with no assigned work", async () => {
    const agents = [
      createAgent({ id: "idle-free", status: "idle", name: "Idle Free" }),
      createAgent({ id: "idle-assigned", status: "idle", name: "Idle Assigned" }),
      createAgent({ id: "running-1", status: "running", name: "Running Agent" }),
      createAgent({ id: "paused-1", status: "paused", pauseReason: "manual", name: "Manual Hold" }),
    ];

    mockIssuesApi.list.mockResolvedValue([
      createIssue({ id: "issue-assigned", assigneeAgentId: "idle-assigned", status: "todo" }),
    ]);

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={agents} />,
      container,
    );

    await waitForAssertion(() => {
      expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1");
    });

    await waitForAssertion(() => {
      const button = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Free Memory"),
      );
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect((button as HTMLButtonElement).disabled).toBe(false);
    });

    clickText(container, "Free Memory");
    await flush();
    clickDialogAction("Free Memory");

    await waitForAssertion(() => {
      expect(mockAgentsApi.pause).toHaveBeenCalledTimes(1);
      expect(mockAgentsApi.pause).toHaveBeenCalledWith("idle-free", "company-1");
      expect(mockAgentsApi.resume).not.toHaveBeenCalled();
      expect(mockAgentsApi.update).not.toHaveBeenCalled();
      expect(toastState.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "success",
          title: "Free Memory complete",
        }),
      );
    });

    act(() => {
      root.unmount();
    });
  });

  it("syncs the dashboard-owned Paperclip copy from the fleet controls", async () => {
    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={[createAgent()]} />,
      container,
    );

    clickText(container, "Sync Dashboard Copy");
    await flush();
    clickDialogAction("Sync Dashboard Copy");

    await waitForAssertion(() => {
      expect(mockInstanceSettingsApi.syncDashboardRepo).toHaveBeenCalledTimes(1);
      expect(toastState.pushToast).toHaveBeenCalledWith(
        expect.objectContaining({
          tone: "success",
          title: "Dashboard copy synced",
        }),
      );
      expect(container.textContent).toContain("Restart the dashboard to load copied code.");
    });

    act(() => {
      root.unmount();
    });
  });

  it("shows compact provider status and watcher routing text", async () => {
    const agents = [
      createAgent({
        id: "planning-support",
        name: "Planning Support",
        adapterType: "process",
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 600 } },
      }),
    ];

    mockCostsApi.quotaWindows.mockResolvedValue([
      {
        provider: "anthropic",
        ok: true,
        source: "claude-cli",
        windows: [{ label: "Current session", usedPercent: 91, resetsAt: "2026-04-13T07:00:00.000Z", valueLabel: null }],
      },
      {
        provider: "openai",
        ok: true,
        source: "codex-rpc",
        windows: [{ label: "5h limit", usedPercent: 24, resetsAt: null, valueLabel: null }],
      },
    ]);

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={agents} />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Provider Watch");
      expect(container.textContent).toContain("Automation Preflight");
      expect(container.textContent).toContain("GitHub healthy");
      expect(container.textContent).toContain("Anthropic pressured");
      expect(container.textContent).toContain("OpenAI available");
      expect(container.textContent).toContain("Current session at 91% used");
      expect(container.textContent).toContain("Provider quota pressure detected — review agent run errors for details.");
    });

    act(() => {
      root.unmount();
    });
  });

  it("detects blocked issues as a flow bottleneck", () => {
    const summary = buildFlowBottleneckSummary(
      [createAgent({ id: "idle-1", status: "idle", runtimeConfig: { heartbeat: { enabled: true } } })],
      [
        createIssue({
          id: "blocked-1",
          identifier: "BLA-223",
          title: "Blocked lane",
          status: "blocked",
        }),
      ],
    );

    expect(summary.state).toBe("detected");
    expect(summary.reason).toBe("blocked");
    expect(summary.detail).toContain("1 blocked issue");
    expect(summary.issueRefs.map((issue) => issue.identifier)).toEqual(["BLA-223"]);
  });

  it("detects stale active work when idle lanes are available", () => {
    const summary = buildFlowBottleneckSummary(
      [
        createAgent({ id: "idle-1", status: "idle", runtimeConfig: { heartbeat: { enabled: true } } }),
        createAgent({ id: "assigned-1", status: "idle", runtimeConfig: { heartbeat: { enabled: true } } }),
      ],
      [
        createIssue({
          id: "stale-1",
          identifier: "BLA-79",
          title: "Old in-progress work",
          status: "in_progress",
          assigneeAgentId: "assigned-1",
          updatedAt: new Date(Date.now() - 19 * 60 * 60 * 1000),
        }),
      ],
    );

    expect(summary.state).toBe("detected");
    expect(summary.reason).toBe("stale");
    expect(summary.detail).toContain("active issue");
    expect(summary.detail).toContain("idle");
  });

  it("detects packetization bottlenecks when ready work is unassigned", () => {
    const summary = buildFlowBottleneckSummary(
      [createAgent({ id: "idle-1", status: "idle", runtimeConfig: { heartbeat: { enabled: true } } })],
      [
        createIssue({
          id: "ready-1",
          identifier: "BLA-13",
          title: "Ready unassigned work",
          status: "todo",
          assigneeAgentId: null,
        }),
      ],
    );

    expect(summary.state).toBe("detected");
    expect(summary.reason).toBe("packetization");
    expect(summary.detail).toContain("unowned");
    expect(summary.issueRefs.map((issue) => issue.identifier)).toEqual(["BLA-13"]);
  });

  it("renders the bottleneck light and reason in the fleet controls", async () => {
    const agents = [
      createAgent({ id: "idle-1", status: "idle", runtimeConfig: { heartbeat: { enabled: true } } }),
    ];

    mockIssuesApi.list.mockResolvedValue([
      createIssue({
        id: "blocked-1",
        identifier: "BLA-256",
        title: "Falcon recovery",
        status: "blocked",
      }),
    ]);

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={agents} />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Flow Bottleneck");
      expect(container.textContent).toContain("Detected");
      expect(container.textContent).toContain("1 blocked issue");
      expect(container.textContent).toContain("BLA-256");
    });

    act(() => {
      root.unmount();
    });
  });

  it("warns when dashboard automation auth is degraded", async () => {
    mockInstanceSettingsApi.getAutomationPreflight.mockResolvedValue({
      checkedAt: "2026-04-13T06:55:00.000Z",
      state: "degraded",
      headline: "Automation Preflight",
      detail: "PR and merge automation is degraded until dashboard-home GitHub auth is healthy.",
      prAutomationDegraded: true,
      checks: [
        {
          id: "github",
          label: "GitHub",
          state: "degraded",
          detail: "GitHub auth is missing from the dashboard home.",
          impacts: ["PR creation", "PR merge automation"],
          lastUpdatedAt: null,
        },
        {
          id: "claude",
          label: "Claude",
          state: "healthy",
          detail: "Claude auth is configured in the dashboard home.",
          impacts: ["Claude-run agent wakes"],
          lastUpdatedAt: "2026-04-09T02:48:40.000Z",
        },
        {
          id: "codex",
          label: "Codex",
          state: "healthy",
          detail: "Codex auth is configured in the dashboard home.",
          impacts: ["Codex-run agent wakes"],
          lastUpdatedAt: "2026-04-05T11:37:44.000Z",
        },
      ],
    });

    const { root } = renderWithQueryClient(
      <BulkAgentControls companyId="company-1" agents={[createAgent()]} />,
      container,
    );

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Automation Preflight");
      expect(container.textContent).toContain("Degraded");
      expect(container.textContent).toContain("GitHub degraded");
      expect(container.textContent).toContain("PR and merge automation is degraded");
    });

    act(() => {
      root.unmount();
    });
  });
});
