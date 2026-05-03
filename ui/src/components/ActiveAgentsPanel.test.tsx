// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";

const mockHeartbeatsApi = vi.hoisted(() => ({
  liveRunsForCompany: vi.fn(),
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/heartbeats", () => ({
  heartbeatsApi: mockHeartbeatsApi,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("./Identity", () => ({
  Identity: ({ name }: { name: string }) => <span>{name}</span>,
}));

vi.mock("./AgentIconPicker", () => ({
  AgentIcon: () => <span data-testid="agent-icon" />,
}));

vi.mock("./RunChatSurface", () => ({
  RunChatSurface: () => <div>Run output</div>,
}));

vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({
    transcriptByRun: new Map(),
    hasOutputForRun: () => false,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function createRun(index: number) {
  return {
    id: `run-${index}`,
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-24T12:00:00.000Z",
    finishedAt: null,
    createdAt: `2026-04-24T12:00:0${index}.000Z`,
    agentId: `agent-${index}`,
    agentName: `Agent ${index}`,
    adapterType: "codex_local",
    issueId: null,
  };
}

function createRunForAgent(overrides: {
  id: string;
  agentId: string;
  agentName: string;
  status?: string;
  createdAt?: string;
  finishedAt?: string | null;
}) {
  return {
    id: overrides.id,
    status: overrides.status ?? "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-24T12:00:00.000Z",
    finishedAt: overrides.finishedAt ?? null,
    createdAt: overrides.createdAt ?? "2026-04-24T12:00:00.000Z",
    agentId: overrides.agentId,
    agentName: overrides.agentName,
    adapterType: "codex_local",
    issueId: null,
  };
}

function createAgent(overrides: { id: string; name: string; role?: string; status?: string }) {
  return {
    id: overrides.id,
    companyId: "company-1",
    name: overrides.name,
    urlKey: overrides.name.toLowerCase(),
    role: overrides.role ?? "general",
    title: null,
    icon: null,
    status: overrides.status ?? "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("ActiveAgentsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([1, 2, 3, 4, 5].map(createRun));
    mockIssuesApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("links hidden active/recent runs to the full live dashboard", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 4,
      limit: undefined,
    });

    const moreLink = [...container.querySelectorAll("a")].find((anchor) =>
      anchor.textContent?.includes("more active/recent"),
    );
    expect(moreLink?.getAttribute("href")).toBe("/dashboard/live");

    await act(async () => {
      root.unmount();
    });
  });

  it("can request the full live dashboard page limit without a hidden-runs link", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel
            companyId="company-1"
            minRunCount={50}
            fetchLimit={50}
            cardLimit={50}
            queryScope="dashboard-live"
            showMoreLink={false}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockHeartbeatsApi.liveRunsForCompany).toHaveBeenCalledWith("company-1", {
      minCount: 50,
      limit: 50,
    });
    expect(container.textContent).not.toContain("more active/recent");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders one card per agent in agents mode, not one per run (regression: #4457)", async () => {
    mockAgentsApi.list.mockResolvedValue([
      createAgent({ id: "agent-ceo", name: "CEO", role: "ceo" }),
      createAgent({ id: "agent-cto", name: "CTO", role: "cto" }),
    ]);
    mockHeartbeatsApi.liveRunsForCompany.mockResolvedValue([
      createRunForAgent({
        id: "run-ceo-1",
        agentId: "agent-ceo",
        agentName: "CEO",
        status: "running",
        createdAt: "2026-04-24T12:00:01.000Z",
      }),
      createRunForAgent({
        id: "run-ceo-2",
        agentId: "agent-ceo",
        agentName: "CEO",
        status: "completed",
        createdAt: "2026-04-24T12:00:00.000Z",
        finishedAt: "2026-04-24T12:01:00.000Z",
      }),
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ActiveAgentsPanel companyId="company-1" displayMode="agents" />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const ceoMatches = container.textContent?.match(/CEO/g) ?? [];
    expect(ceoMatches.length).toBe(1);
    expect(container.textContent).toContain("CTO");
    expect(container.textContent).toContain("Idle");

    await act(async () => {
      root.unmount();
    });
  });
});
