// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";
import { i18n } from "@/i18n";

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
    void i18n.changeLanguage("en");
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
    await act(async () => { await i18n.changeLanguage("ru"); });
    expect(container.textContent).toContain("Управление бюджетом");
    expect(container.textContent).toContain("Активные инциденты");
    expect(budgetOverviewMock).toHaveBeenCalledWith("company-1");
    await act(async () => { await i18n.changeLanguage("en"); });
    expect(container.textContent).toContain("Budget control plane");
  });
});
