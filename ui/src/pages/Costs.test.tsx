vi.mock("../components/AccountingHealthPanel", () => ({ AccountingHealthPanel: () => null }));
// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";
import { MemoryRouter } from "react-router-dom";

const upsertPolicyMock = vi.hoisted(() => vi.fn());
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
    upsertPolicy: upsertPolicyMock,
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

const surfaces = [
  ["streamlined", { embedded: true, hideBudgetsTab: true }],
  ["standalone", {}],
] as const;

describe("Shared Costs surfaces", () => {
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

  it.each(["reservation", "unknown price", "amount"])("preserves all other budget settings when editing %s", async (field) => {
    const summary = {
      policyId: "policy", companyId: "company-1", scopeType: "agent", scopeId: "agent", scopeName: "Worker", metric: "billed_cents", windowKind: "lifetime",
      amount: 500, warnPercent: 65, hardStopEnabled: false, notifyEnabled: false, isActive: false, unpricedUsagePolicy: "allow", reservationCents: "2.0000000",
      observedAmount: 0, remainingAmount: 500, utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false, pauseReason: null,
    };
    budgetOverviewMock.mockResolvedValue({ policies: [summary], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    upsertPolicyMock.mockResolvedValue({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><Costs embedded initialTab="budgets" lockTab /></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[aria-label="Reserve per run (USD)"]')).not.toBeNull()); });
    if (field === "unknown price") await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    else {
      const element = field === "reservation" ? container.querySelector<HTMLInputElement>('[aria-label="Reserve per run (USD)"]')! : container.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([aria-label])')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "1");
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const label = field === "reservation" ? "Update reservation" : "Update budget";
      await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === label)!.click());
    }
    await act(async () => { await vi.waitFor(() => expect(upsertPolicyMock).toHaveBeenCalled()); });
    expect(upsertPolicyMock).toHaveBeenCalledWith("company-1", {
      scopeType: summary.scopeType, scopeId: summary.scopeId, metric: summary.metric, windowKind: summary.windowKind,
      amount: field === "amount" ? 100 : 500, warnPercent: 65, hardStopEnabled: false, notifyEnabled: false, isActive: false,
      unpricedUsagePolicy: field === "unknown price" ? "block" : "allow", reservationCents: field === "reservation" ? "100.0000000" : "2.0000000",
    });
    queryClient.clear();
  });

  it.each(surfaces)("shows incomplete accounting and currency boundaries on the %s page", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: false, unpricedEventCount: 2, pendingRunCount: 1 });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 1,
      currencies: [{ currency: "EUR", netCents: 100 }],
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>);
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.textContent).toContain("Spend is incomplete: 2 usage events have no reliable price; 1 runs await accounting."));
    });
    expect(container.textContent).toContain("Finance headline totals are USD only");
  });

  it.each(surfaces)("labels each agent and expanded model independently on the %s page", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.summary.mockResolvedValue({ spendCents: 600, budgetCents: 0, pricingComplete: true, estimatedEventCount: 3 });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const base = { costCents: 200, inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, apiRunCount: 2, subscriptionRunCount: 0, eventCount: 2 };
    costsApiMocks.byAgent.mockResolvedValue([
      { ...base, agentId: "codie", agentName: "Codie", estimatedEventCount: 2 },
      { ...base, agentId: "mixed", agentName: "Mixed", estimatedEventCount: 1 },
      { ...base, agentId: "reported", agentName: "Reported", estimatedEventCount: 0 },
      { ...base, agentId: "legacy", agentName: "Legacy", eventCount: undefined },
    ]);
    costsApiMocks.byAgentModel.mockResolvedValue([
      { ...base, agentId: "mixed", provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-astra", eventCount: 1, estimatedEventCount: 1 },
      { ...base, agentId: "mixed", provider: "openai", biller: "openai", billingType: "metered_api", model: "gpt-6-sol", eventCount: 1, estimatedEventCount: 0 },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>);
    });
    await act(async () => {
      await vi.waitFor(() => expect(container.querySelector('[aria-label="Codie costs"]')).not.toBeNull());
    });
    const card = (name: string) => container.querySelector<HTMLElement>(`[aria-label="${name} costs"]`)!;
    expect(card("Codie").textContent).toContain("Estimated");
    expect(card("Codie").textContent).not.toContain("Partially estimated");
    expect(card("Mixed").textContent).toContain("Partially estimated");
    expect(card("Reported").textContent).not.toMatch(/Estimated|Partially estimated/);
    expect(card("Legacy").textContent).not.toMatch(/Estimated|Partially estimated/);
    await act(async () => card("Mixed").querySelector<HTMLElement>(".cursor-pointer")!.click());
    const breakdown = card("Mixed").querySelector(".border-l")!;
    expect(breakdown.textContent).toContain("gpt-6-astra");
    expect(breakdown.querySelectorAll('[data-slot="badge"]')).toHaveLength(1);
    expect(breakdown.querySelector('[data-slot="badge"]')!.textContent).toBe("Estimated");
    // The count is for charges, not runs; it must not use apiRunCount or the
    // page-wide estimated count when determining whether a row is mixed.
    expect(breakdown.querySelector('[data-slot="badge"]')!.getAttribute("title")).toContain("1 estimated charge.");
  });

  it.each(surfaces)("preserves the %s heading, breadcrumbs and tab navigation", async (name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>);
    });
    const streamlined = name === "streamlined";
    expect(container.querySelector(streamlined ? "h2" : "h1")?.textContent).toBe("Costs");
    if (streamlined) {
      expect(container.querySelector("h1")).toBeNull();
      expect(setBreadcrumbsMock).not.toHaveBeenCalled();
    } else {
      expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Costs" }]);
    }
    expect([...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toEqual(
      streamlined ? ["Overview", "Providers", "Billers", "Finance"] : ["Overview", "Budgets", "Providers", "Billers", "Finance"],
    );
  });

});
