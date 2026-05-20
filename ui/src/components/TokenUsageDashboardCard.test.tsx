// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, DashboardTokenUsageRange } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenUsageDashboardCard } from "./TokenUsageDashboardCard";

const mockDashboardApi = vi.hoisted(() => ({
  tokenUsage: vi.fn(),
}));

vi.mock("../api/dashboard", () => ({
  dashboardApi: mockDashboardApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createUsage(range: DashboardTokenUsageRange, agentId: string | null) {
  const agentName = agentId ? "CTO" : null;
  return {
    companyId: "company-1",
    range,
    scope: {
      type: agentId ? "single_agent" : "all_agents",
      agentId,
      agentName,
      label: agentName ?? "All agents",
    },
    timezone: "UTC",
    windowStartAt: "2026-01-01T00:00:00.000Z",
    windowEndAt: "2026-05-20T23:59:59.999Z",
    generatedAt: "2026-05-20T12:00:00.000Z",
    totals: {
      inputTokens: 1200,
      cachedInputTokens: 300,
      outputTokens: 500,
      totalTokens: 2000,
      runCount: 4,
    },
    buckets: [
      {
        key: "2026-05-01",
        label: "2026/05",
        startAt: "2026-05-01T00:00:00.000Z",
        endAt: "2026-05-20T23:59:59.999Z",
        inputTokens: 1200,
        cachedInputTokens: 300,
        outputTokens: 500,
        totalTokens: 2000,
        runCount: 4,
      },
    ],
  };
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("TokenUsageDashboardCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockDashboardApi.tokenUsage.mockImplementation((_companyId: string, query: { range: DashboardTokenUsageRange; agentId?: string | null }) =>
      Promise.resolve(createUsage(query.range, query.agentId ?? null)),
    );
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders monthly by default and supports range plus agent filters", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const agents = [
      { id: "agent-1", name: "CTO" },
      { id: "agent-2", name: "QA" },
    ] as Agent[];

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TokenUsageDashboardCard companyId="company-1" agents={agents} />
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      expect(mockDashboardApi.tokenUsage).toHaveBeenCalledWith("company-1", { range: "monthly", agentId: null });
      expect(container.textContent).toContain("Range: Last 6 months");
      expect(container.textContent).toContain("Daily");
      expect(container.textContent).toContain("Weekly");
      expect(container.textContent).toContain("Monthly");
    });

    const dailyButton = [...container.querySelectorAll("button")].find((button) => button.textContent === "Daily");
    expect(dailyButton).toBeTruthy();
    await act(async () => {
      dailyButton!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockDashboardApi.tokenUsage).toHaveBeenCalledWith("company-1", { range: "daily", agentId: null });
      expect(container.textContent).toContain("Range: Last 7 days");
    });

    const select = container.querySelector("select");
    expect(select).toBeTruthy();
    await act(async () => {
      select!.value = "agent-1";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await waitForAssertion(() => {
      expect(mockDashboardApi.tokenUsage).toHaveBeenCalledWith("company-1", { range: "daily", agentId: "agent-1" });
      expect(container.textContent).toContain("Scope: CTO");
    });

    await act(async () => {
      root.unmount();
    });
    queryClient.clear();
  });
});
