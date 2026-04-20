// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const breadcrumbsState = vi.hoisted(() => ({
  setBreadcrumbs: vi.fn(),
}));

const budgetsApiMock = vi.hoisted(() => ({
  overview: vi.fn(),
  resolveIncident: vi.fn(),
  upsertPolicy: vi.fn(),
}));

const costsApiMock = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byProject: vi.fn(),
  byAgentModel: vi.fn(),
  workValue: vi.fn(),
  financeSummary: vi.fn(),
  financeByBiller: vi.fn(),
  financeByKind: vi.fn(),
  financeEvents: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  quotaWindows: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => breadcrumbsState,
}));

vi.mock("../api/budgets", () => ({
  budgetsApi: budgetsApiMock,
}));

vi.mock("../api/costs", () => ({
  costsApi: costsApiMock,
}));

async function flushQueries() {
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderCosts(container: HTMLElement): Promise<Root> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Costs />
      </QueryClientProvider>,
    );
  });
  await flushQueries();
  return root;
}

describe("Costs", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    budgetsApiMock.overview.mockResolvedValue({
      policies: [],
      activeIncidents: [],
      pausedAgentCount: 0,
      pausedProjectCount: 0,
      pendingApprovalCount: 0,
    });
    costsApiMock.summary.mockResolvedValue({
      companyId: "company-1",
      spendCents: 450,
      budgetCents: 0,
      utilizationPercent: 0,
    });
    costsApiMock.byAgent.mockResolvedValue([]);
    costsApiMock.byProject.mockResolvedValue([]);
    costsApiMock.byAgentModel.mockResolvedValue([]);
    costsApiMock.workValue.mockResolvedValue({
      companyId: "company-1",
      totalTokens: 250000,
      inputTokens: 180000,
      cachedInputTokens: 20000,
      outputTokens: 50000,
      aiSpendCents: 450,
      estimatedDevHours: 2.5,
      estimatedDevValueCents: 37500,
      estimatedSavingsCents: 37050,
      roiMultiple: 83.33,
      devValueHourlyRateCents: 15000,
      devValueTokensPerHour: 100000,
    });
    costsApiMock.financeSummary.mockResolvedValue({
      companyId: "company-1",
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      estimatedDebitCents: 0,
      eventCount: 0,
    });
    costsApiMock.financeByBiller.mockResolvedValue([]);
    costsApiMock.financeByKind.mockResolvedValue([]);
    costsApiMock.financeEvents.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the developer value estimate for the selected period", async () => {
    const root = await renderCosts(container);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Dev value estimate");
      expect(container.textContent).toContain("$375.00");
      expect(container.textContent).toContain("2.5h estimated dev time");
      expect(container.textContent).toContain("250.0k tokens");
      expect(container.textContent).toContain("$370.50");
      expect(container.textContent).toContain("83x");
    });

    act(() => root.unmount());
  });
});
