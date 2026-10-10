// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";
import { CostByUserTable } from "../components/CostByUserTable";
import { MemoryRouter } from "react-router-dom";

const resolveIncidentMock = vi.hoisted(() => vi.fn());
const upsertPolicyMock = vi.hoisted(() => vi.fn());
const budgetOverviewMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const decisionHistoryMock = vi.hoisted(() => vi.fn());
const costsApiMocks = vi.hoisted(() => ({
  summary: vi.fn(),
  byAgent: vi.fn(),
  byUser: vi.fn(),
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
const subscriptionsMocks = vi.hoisted(() => ({ report: vi.fn(), refresh: vi.fn(), update: vi.fn(), link: vi.fn() }));
vi.mock("../api/subscriptions", () => ({ subscriptionsApi: subscriptionsMocks }));

vi.mock("../api/budgets", () => ({
  budgetsApi: {
    overview: (...args: unknown[]) => budgetOverviewMock(...args),
    upsertPolicy: upsertPolicyMock,
    resolveIncident: resolveIncidentMock,
  },
}));

vi.mock("../api/costs", () => ({ costsApi: costsApiMocks }));
vi.mock("../api/decision-models", () => ({ decisionModelsApi: { history: decisionHistoryMock } }));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));

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
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, costCents: "0", eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0 };
    subscriptionsMocks.report.mockResolvedValue({ canRefresh: false, asOf: "2026-10-08T00:00:00Z", accounts: [], monthlyTotals: [], activeCount: 0, unknownPriceCount: 0, unidentifiedAccountCount: 0, api: usage, subscription: usage, unknown: usage, unattributedSubscription: usage });
    decisionHistoryMock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
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

  it.each([0, 125])("shows $%s of known user spend while retaining an unpriced warning", async (costCents) => {
    root = createRoot(container);
    await act(async () => root.render(<CostByUserTable report={{ activeUserCount: 1, rows: [{
      userId: null, userName: null, userImage: null, runCount: 1, eventCount: 1, estimatedEventCount: 0, unpricedEventCount: 1,
      costCents, costCentsExact: `${costCents}.0000000`, inputTokens: 10, cachedInputTokens: 0, outputTokens: 2,
    }] }} />));
    expect(container.querySelector("tbody tr td:last-child")?.textContent).toContain(costCents > 0 ? "$1.25" : "—");
    expect(container.textContent).toContain("1 unpriced charge");
  });

  it.each(surfaces)("labels other and unknown billing accurately on the %s surface", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 600, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const report = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...report, unknown: { ...report.unknown,
      inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, costCents: "600", eventCount: 3,
    } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain(
      "150 tokens have other or unknown billing types, with $6.00 in recorded charges. They remain in the inference ledger.",
    )));
    expect(container.textContent).not.toContain("tokens have an unknown billing type");
  });

  it("renders a focused Budgets section without duplicate Costs chrome or spend queries", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter>
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

  it("opens linked decision history with real date bounds instead of report cache labels", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter initialEntries={["/?tab=decisions"]}><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("No decision requests in this period")); });
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Decisions");
    const [companyId, from, to] = decisionHistoryMock.mock.lastCall!;
    expect(companyId).toBe("company-1");
    expect(Number.isFinite(Date.parse(from))).toBe(true);
    expect(Number.isFinite(Date.parse(to))).toBe(true);
    queryClient.clear();
  });

  it.each([
    ["reservation", 500, "agent"], ["unknown price", 500, "agent"], ["amount", 500, "agent"],
    ["amount", 0, "company"], ["amount", 0, "agent"], ["amount", 0, "project"],
  ] as const)("preserves other settings when editing %s from %s on a %s budget", async (field, previousAmount, scopeType) => {
    const summary = {
      policyId: "policy", companyId: "company-1", scopeType, scopeId: "agent", scopeName: "Worker", metric: "billed_cents", windowKind: "lifetime",
      amount: previousAmount, warnPercent: 65, hardStopEnabled: false, notifyEnabled: false, isActive: false, unpricedUsagePolicy: "allow", reservationCents: "2.0000000",
      observedAmount: 0, remainingAmount: 500, utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false, pauseReason: null,
    };
    budgetOverviewMock.mockResolvedValue({ policies: [summary], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    upsertPolicyMock.mockResolvedValue({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[aria-label="Reserve per run (USD)"]')).not.toBeNull()); });
    const advanced = container.querySelector("details")!;
    expect(advanced.open).toBe(false);
    if (field !== "amount") await act(async () => advanced.querySelector("summary")!.click());
    if (field === "unknown price") await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    else {
      const element = field === "reservation" ? container.querySelector<HTMLInputElement>('[aria-label="Reserve per run (USD)"]')! : container.querySelector<HTMLInputElement>('input:not([type="checkbox"]):not([aria-label])')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, "1");
        element.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const label = field === "reservation" ? "Update reservation" : previousAmount === 0 ? "Set budget" : "Update budget";
      await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === label)!.click());
    }
    await act(async () => { await vi.waitFor(() => expect(upsertPolicyMock).toHaveBeenCalled()); });
    expect(upsertPolicyMock).toHaveBeenCalledWith("company-1", {
      scopeType: summary.scopeType, scopeId: summary.scopeId, metric: summary.metric, windowKind: summary.windowKind,
      ...(field === "amount" ? { amount: 100 } : field === "unknown price" ? { unpricedUsagePolicy: "block" } : { reservationCents: "100.0000000" }),
    });
    queryClient.clear();
  });

  it("shows a safe policy-save failure without losing the operator's settings", async () => {
    const policy = {
      policyId: "policy", companyId: "company-1", scopeType: "agent", scopeId: "agent", scopeName: "Worker", metric: "billed_cents", windowKind: "lifetime",
      amount: 500, warnPercent: 65, hardStopEnabled: false, notifyEnabled: false, isActive: false, unpricedUsagePolicy: "allow", reservationCents: "2.0000000",
      observedAmount: 0, remainingAmount: 500, utilizationPercent: 0, unpricedEventCount: 0, pendingRunCount: 0, status: "ok", paused: false, pauseReason: null,
    };
    budgetOverviewMock.mockResolvedValue({ policies: [policy], activeIncidents: [], pausedAgentCount: 0, pausedProjectCount: 0 });
    upsertPolicyMock.mockRejectedValueOnce(new Error("private SQL policy error"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<QueryClientProvider client={queryClient}><MemoryRouter><Costs embedded initialTab="budgets" lockTab /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('input[type="checkbox"]')).not.toBeNull()); });
    const reservation = container.querySelector<HTMLInputElement>('[aria-label="Reserve per run (USD)"]')!;
    const originalReservation = reservation.value;
    await act(async () => container.querySelector("details summary")!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not update the budget policy")); });
    expect(container.textContent).toContain("Worker");
    expect(container.textContent).not.toContain("private SQL");
    expect(reservation.value).toBe(originalReservation);
    queryClient.clear();
  });

  it.each(surfaces)("shows failed budget actions on the %s Overview", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 200, budgetCents: 1000, pricingComplete: false });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    budgetOverviewMock.mockResolvedValue({ policies: [], activeIncidents: [{ id: "incident", scopeType: "agent", scopeName: "Codie", status: "open", thresholdType: "hard", amountObserved: 200, amountLimit: 1000 }], pausedAgentCount: 1, pausedProjectCount: 0 });
    resolveIncidentMock.mockRejectedValue(new Error("private database error"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} /></QueryClientProvider></MemoryRouter>));
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Raise budget & resume")); });
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "Raise budget & resume")!.click());
    await act(async () => { await vi.waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not update the budget")); });
    expect(resolveIncidentMock).toHaveBeenCalledWith("company-1", "incident", { incidentId: "incident", action: "raise_budget_and_resume", amount: 1200 });
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Overview");
    expect(container.textContent).toContain("Check any pending runs or unpriced usage shown on this page");
    expect(container.textContent).not.toContain("private database error");
    queryClient.clear();
  });

  it("retries failed account discovery without discarding the last subscription report", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const report = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...report, canRefresh: true, activeCount: 1, monthlyTotals: [{ currency: "USD", amountCents: "2000", estimatedCount: 1 }] });
    subscriptionsMocks.refresh.mockRejectedValueOnce(new Error("private connection error")).mockResolvedValue({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    const retry = () => [...container.querySelectorAll("button")].find(button => button.textContent === "Retry account check");
    await act(async () => { await vi.waitFor(() => expect(retry()).toBeDefined()); });
    expect(container.textContent).toContain("$20.00/month");
    expect(container.textContent).not.toContain("private connection error");
    await act(async () => retry()!.click());
    await act(async () => { await vi.waitFor(() => expect(retry()).toBeUndefined()); });
    expect(subscriptionsMocks.refresh).toHaveBeenCalledTimes(2);
    expect(subscriptionsMocks.refresh).toHaveBeenLastCalledWith("company-1");
    expect(container.textContent).toContain("$20.00/month");
    queryClient.clear();
  });

  it("keeps monthly subscription fees through date changes and failed background reloads", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 200, budgetCents: 0, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const report = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...report, activeCount: 1, monthlyTotals: [{ currency: "USD", amountCents: "2000", estimatedCount: 1 }], api: { ...report.api, costCents: "200" } });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    const card = (label: string) => [...container.querySelectorAll("div")].find(node => node.textContent === label)?.closest('[data-slot="card"]');
    await act(async () => { await vi.waitFor(() => expect(card("Subscriptions")?.textContent).toContain("$20.00/month")); });
    expect(card("API spend")?.textContent).toContain("$2.00");
    subscriptionsMocks.report.mockResolvedValue({ ...report, activeCount: 1, monthlyTotals: [{ currency: "USD", amountCents: "2000", estimatedCount: 1 }], api: { ...report.api, costCents: "300" } });
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "All Time")!.click());
    await act(async () => { await vi.waitFor(() => expect(card("API spend")?.textContent).toContain("$3.00")); });
    expect(card("Subscriptions")?.textContent).toContain("$20.00/month");
    expect(subscriptionsMocks.report).toHaveBeenLastCalledWith("company-1", undefined, undefined);
    subscriptionsMocks.report.mockRejectedValue(new Error("private provider failure"));
    await act(async () => { await queryClient.invalidateQueries({ queryKey: ["cost-subscriptions"] }); });
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("Showing the last loaded API and subscription usage")); });
    expect(card("API spend")?.textContent).toContain("$3.00");
    expect(card("Subscriptions")?.textContent).toContain("$20.00/month");
    expect(container.textContent).not.toContain("private provider failure");
    queryClient.clear();
  });

  it("compares monthly budgets only with month-to-date spend", async () => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 200, budgetCents: 1000, utilizationPercent: 20, pricingComplete: true });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(container);
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs /></QueryClientProvider></MemoryRouter>));
    const budgetCard = () => [...container.querySelectorAll("div")].find(node => node.textContent === "Budget")?.closest('[data-slot="card"]');
    await act(async () => { await vi.waitFor(() => expect(budgetCard()?.textContent).toContain("20%")); });
    expect(budgetCard()?.textContent).toContain("$2.00 of $10.00 this month");
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12000, budgetCents: 1000, utilizationPercent: 1200, pricingComplete: true });
    const subscriptionReport = await subscriptionsMocks.report();
    subscriptionsMocks.report.mockResolvedValue({ ...subscriptionReport, api: { ...subscriptionReport.api, costCents: "12000" } });
    await act(async () => [...container.querySelectorAll("button")].find(b => b.textContent === "All Time")!.click());
    await act(async () => { await vi.waitFor(() => expect(container.textContent).toContain("$120.00")); });
    expect(budgetCard()?.textContent).toContain("$10.00");
    expect(budgetCard()?.textContent).toContain("Monthly limit");
    expect(container.textContent).not.toContain("1200%");
    expect(container.textContent).not.toContain("of monthly budget consumed");
    expect(costsApiMocks.summary).toHaveBeenLastCalledWith("company-1", undefined, undefined);
    queryClient.clear();
  });

  it.each(surfaces)("uses the displayed company cap for provider warnings on the %s page", async (_name, props) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T00:30:00Z"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
      costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
      costsApiMocks.summary.mockResolvedValue({ spendCents: 800, budgetCents: 1000, pricingComplete: true });
      const row = { model: "test", billingType: "metered_api", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
        apiRunCount: 1, subscriptionRunCount: 0, subscriptionInputTokens: 0, subscriptionCachedInputTokens: 0, subscriptionOutputTokens: 0 };
      costsApiMocks.byProvider.mockResolvedValue([
        { ...row, provider: "openai", biller: "openai", costCents: 100 },
        { ...row, provider: "google", biller: "google", costCents: 700 },
      ]);
      root = createRoot(container);
      await act(async () => root.render(<MemoryRouter><QueryClientProvider client={queryClient}><Costs {...props} initialTab="providers" /></QueryClientProvider></MemoryRouter>));
      await act(async () => { await vi.waitFor(() => expect(container.querySelectorAll('[aria-label^="Period spend:"]')).toHaveLength(2)); });
      const bar = (percent: number) => container.querySelector(`[aria-label="Period spend: ${percent}%"]`)!.parentElement!;
      expect(bar(10).querySelector(".bg-destructive")).toBeNull();
      expect(bar(70).querySelector(".bg-destructive")).not.toBeNull();
      expect(container.textContent).toContain("10% of company budget");
      expect(container.textContent).toContain("70% of company budget");
      await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "All Time")!.click());
      await act(async () => { await vi.waitFor(() => expect(container.querySelector('[aria-label^="Period spend:"]')).toBeNull()); });
    } finally { queryClient.clear(); vi.useRealTimers(); }
  });

  it.each(surfaces)("explains missing costs and pending runs neutrally on the %s page", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
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
      await vi.waitFor(() => expect(container.textContent).toContain("Costs are unavailable for 2 usage entries in this period. Totals include known costs only."));
    });
    const notice = [...container.querySelectorAll('[role="status"]')].find(element => element.textContent?.includes("Costs are unavailable"))!;
    expect(notice.classList.contains("text-muted-foreground")).toBe(true);
    expect(notice.querySelector(".text-destructive")).toBeNull();
    expect(notice.classList.contains("text-destructive")).toBe(false);
    expect(notice.textContent).toContain("1 run is awaiting cost data.");
    expect(notice.previousElementSibling?.textContent).toContain("API spend");
    expect(container.textContent).toContain("Finance headline totals are USD only");
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: false, unpricedEventCount: 10, pendingRunCount: 0 });
    await act(async () => { await queryClient.invalidateQueries(); });
    await vi.waitFor(() => expect(notice.textContent).toContain("Costs are unavailable for 10 usage entries"));
    expect(notice.textContent).not.toContain("awaiting cost data");
    expect(notice.textContent).not.toContain("0 runs");
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: false, unpricedEventCount: 0, pendingRunCount: 1 });
    await act(async () => { await queryClient.invalidateQueries(); });
    await vi.waitFor(() => expect(notice.textContent).toBe("1 run is awaiting cost data."));
    costsApiMocks.summary.mockResolvedValue({ spendCents: 12.4, budgetCents: 0, pricingComplete: true, unpricedEventCount: 0, pendingRunCount: 0 });
    await act(async () => { await queryClient.invalidateQueries(); });
    await vi.waitFor(() => expect(container.contains(notice)).toBe(false));
  });

  it.each(surfaces)("labels each agent, project, and expanded model independently on the %s page", async (_name, props) => {
    for (const mock of Object.values(costsApiMocks)) mock.mockResolvedValue([]);
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    costsApiMocks.summary.mockResolvedValue({ spendCents: 600, budgetCents: 0, pricingComplete: true, estimatedEventCount: 3 });
    costsApiMocks.financeSummary.mockResolvedValue({ netCents: 0, debitCents: 0, creditCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    const base = { costCents: 200, inputTokens: 10, cachedInputTokens: 5, outputTokens: 2, apiRunCount: 2, subscriptionRunCount: 0, eventCount: 2 };
    costsApiMocks.byProject.mockResolvedValue([
      { ...base, projectId: "estimated-project", projectName: "Estimated project", estimatedEventCount: 2 },
      { ...base, projectId: "mixed-project", projectName: "Mixed project", estimatedEventCount: 1 },
      { ...base, projectId: "reported-project", projectName: "Reported project", estimatedEventCount: 0 },
    ]);
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
    const projectBadge = (name: string) => [...container.querySelectorAll("span")]
      .find(element => element.textContent === name)!.parentElement!.querySelector('[data-slot="badge"]');
    expect(projectBadge("Estimated project")?.textContent).toBe("Estimated");
    expect(projectBadge("Mixed project")?.textContent).toBe("Partially estimated");
    expect(projectBadge("Reported project")).toBeNull();
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
    costsApiMocks.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
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
      streamlined ? ["Overview", "Providers", "Billers", "Finance", "Decisions", "Fast responses"] : ["Overview", "Budgets", "Providers", "Billers", "Finance", "Decisions", "Fast responses"],
    );
  });

});
