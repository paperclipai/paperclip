// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";

const budgetOverviewMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const costsApiMocks = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetOverviewMock(...args),
    upsertPolicy: vi.fn(),
    resolveIncident: vi.fn(),
  },
}));

vi.mock("../api/costs", () => ({ costsApi: costsApiMocks }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("Costs embedded Audit surfaces", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    budgetOverviewMock.mockResolvedValue({
      policies: [],
      activeIncidents: [],
      pendingApprovalCount: 0,
      pausedAgentCount: 0,
      pausedProjectCount: 0,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("renders a focused Budgets section without duplicate Costs chrome or spend queries", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Costs embedded initialTab="budgets" lockTab />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(budgetOverviewMock).toHaveBeenCalledWith("company-1");
        expect(container.textContent).toContain("Budget control plane");
      });
    });
    expect(container.textContent).not.toContain("Inference spend");
    expect(container.querySelector('[role="tab"]')).toBeFalsy();
    expect(setBreadcrumbsMock).not.toHaveBeenCalled();
    for (const mock of Object.values(costsApiMocks)) expect(mock).not.toHaveBeenCalled();
  });

  it("shows each OpenAI subscription account's quota, including one that failed", async () => {
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, utilizationPercent: 0 });
    costsApiMocks.byAgent.mockResolvedValue([]);
    costsApiMocks.byProject.mockResolvedValue([]);
    costsApiMocks.byAgentModel.mockResolvedValue([]);
    costsApiMocks.financeSummary.mockResolvedValue({
      companyId: "company-1",
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
    costsApiMocks.financeByBiller.mockResolvedValue([]);
    costsApiMocks.financeByKind.mockResolvedValue([]);
    costsApiMocks.financeEvents.mockResolvedValue([]);
    costsApiMocks.byProvider.mockResolvedValue([
      {
        provider: "openai",
        biller: "openai",
        billingType: "subscription_included",
        model: "gpt-5",
        costCents: 0,
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        apiRunCount: 0,
        subscriptionRunCount: 1,
        subscriptionCachedInputTokens: 0,
        subscriptionInputTokens: 10,
        subscriptionOutputTokens: 5,
      },
    ]);
    costsApiMocks.windowSpend.mockResolvedValue([]);
    const window = (usedPercent: number) => ({ label: "5h limit", usedPercent, resetsAt: null, valueLabel: null, detail: null });
    costsApiMocks.quotaWindows.mockResolvedValue([
      { provider: "openai", source: "codex-wham", ok: true, accountName: "Plus account", windows: [window(11)] },
      { provider: "openai", source: "codex-wham", ok: true, accountName: "Pro account", windows: [window(77)] },
      { provider: "openai", ok: false, accountName: "Broken account", error: "Reconnect this AI account", windows: [] },
    ]);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Costs embedded initialTab="providers" lockTab />
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    await act(async () => {
      await vi.waitFor(() => {
        const text = container.textContent ?? "";
        for (const expected of ["Plus account", "Pro account", "Broken account", "Reconnect this AI account", "11%", "77%"]) {
          expect(text).toContain(expected);
        }
      });
    });
  });
});
