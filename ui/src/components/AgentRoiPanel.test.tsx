// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRoiPanel } from "./AgentRoiPanel";
import type { CostByAgent } from "@paperclipai/shared";

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("./Identity", () => ({
  Identity: ({ agentId, name }: { agentId?: string; name?: string }) => (
    <span data-testid="identity">{name ?? agentId}</span>
  ),
}));

vi.mock("./StatusBadge", () => ({
  StatusBadge: ({ status }: { status: string }) => <span>{status}</span>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function makeAgent(index: number, costCents: number): CostByAgent {
  return {
    agentId: `agent-${index}`,
    agentName: `Agent ${index}`,
    agentStatus: "active",
    costCents,
    inputTokens: 1000,
    cachedInputTokens: 0,
    outputTokens: 200,
    apiRunCount: 3,
    subscriptionRunCount: 0,
    subscriptionCachedInputTokens: 0,
    subscriptionInputTokens: 0,
    subscriptionOutputTokens: 0,
  };
}

function makeIssue(agentId: string, status: "done" | "in_progress" | "blocked") {
  return {
    id: `issue-${Math.random()}`,
    companyId: "company-1",
    identifier: "PAP-1",
    title: "Some task",
    description: null,
    status,
    priority: "medium",
    assigneeAgentId: agentId,
    assigneeUserId: null,
    parentId: null,
    projectId: null,
    projectWorkspaceId: null,
    executionWorkspaceId: null,
    goalId: null,
    labels: [],
    blockedByIssueIds: [],
    blocksIssueIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("AgentRoiPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(byAgent: CostByAgent[]) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AgentRoiPanel companyId="company-1" byAgent={byAgent} periodLabel="MTD" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    return { root };
  }

  it("shows empty state when no byAgent data", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = await render([]);
    expect(container.textContent).toContain("No agent cost data for the selected period");
    await act(async () => { root.unmount(); });
  });

  it("renders a row per agent and KPI tiles", async () => {
    mockIssuesApi.list.mockResolvedValue([
      makeIssue("agent-1", "done"),
      makeIssue("agent-1", "done"),
      makeIssue("agent-2", "in_progress"),
    ]);

    const { root } = await render([makeAgent(1, 5000), makeAgent(2, 1000)]);
    await flushReact();

    expect(container.textContent).toContain("Agent 1");
    expect(container.textContent).toContain("Agent 2");

    // KPI tile: label "Done Tasks (all-time)" appears before the count "2"
    expect(container.textContent).toMatch(/Done Tasks \(all-time\)2/);

    await act(async () => { root.unmount(); });
  });

  it("computes ROI ratings based on cost-per-done percentile", async () => {
    // 3 agents needed so p66 < max: cheapest=Excellent, mid=Good, priciest=Poor
    mockIssuesApi.list.mockResolvedValue([
      makeIssue("agent-1", "done"),
      makeIssue("agent-2", "done"),
      makeIssue("agent-3", "done"),
    ]);

    const { root } = await render([makeAgent(1, 1000), makeAgent(2, 5000), makeAgent(3, 20000)]);
    await flushReact();

    expect(container.textContent).toContain("Excellent");
    expect(container.textContent).toContain("Poor");

    await act(async () => { root.unmount(); });
  });

  it("fetches issues for the given companyId", async () => {
    mockIssuesApi.list.mockResolvedValue([]);
    const { root } = await render([makeAgent(1, 1000)]);
    await flushReact();

    expect(mockIssuesApi.list).toHaveBeenCalledWith("company-1");

    await act(async () => { root.unmount(); });
  });
});
