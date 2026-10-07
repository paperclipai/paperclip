// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs, type CostsProps } from "./Costs";
import { SidebarProvider } from "../context/SidebarContext";

const state = vi.hoisted(() => ({ companyId: "company-1", breadcrumbs: vi.fn() }));
const overview = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => Object.fromEntries([
  "summary", "byUser", "byAgent", "byProject", "byAgentModel", "financeSummary", "financeByBiller",
  "financeByKind", "financeEvents", "byProvider", "byBiller", "windowSpend", "quotaWindows",
].map((key) => [key, vi.fn()])));
vi.mock("../api/costs", () => ({ costsApi: api }));
vi.mock("../api/budgets", () => ({ budgetsApi: { overview, upsertPolicy: vi.fn(), resolveIncident: vi.fn() } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: state.companyId }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: state.breadcrumbs }) }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe.each([
  ["streamlined", { embedded: true, hideBudgetsTab: true }],
  ["standalone", {}],
] as const)("%s cost refresh", (name, props) => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let client: QueryClient;

  async function settle() {
    for (let i = 0; i < 3; i++) await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  }
  async function render(overrides: CostsProps = {}) {
    await act(async () => root.render(
      <MemoryRouter><SidebarProvider><QueryClientProvider client={client}><Costs {...props} initialTab="overview" {...overrides} /></QueryClientProvider></SidebarProvider></MemoryRouter>,
    ));
    await settle();
  }
  async function click(text: string) {
    const button = [...document.querySelectorAll("button")].find((node) => node.textContent === text);
    expect(button).toBeDefined();
    await act(async () => {
      if (button!.getAttribute("role") === "tab") {
        button!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      }
      button!.click();
    });
    await settle();
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.setSystemTime(new Date("2026-09-29T12:00:10Z"));
    state.companyId = "company-1";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    for (const mock of Object.values(api)) mock.mockReset().mockResolvedValue([]);
    api.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    overview.mockReset().mockResolvedValue({ policies: [], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    api.summary.mockResolvedValue({ companyId: state.companyId, spendCents: 40288, budgetCents: 0, utilizationPercent: 0 });
    api.financeSummary.mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, estimatedDebitCents: 0, eventCount: 0 });
    api.byAgent.mockResolvedValue([{
      agentId: "agent-bender", agentName: "Bender", agentStatus: "idle", costCents: 40288,
      inputTokens: 62100000, cachedInputTokens: 200000000, outputTokens: 2000000,
      apiRunCount: 72, subscriptionRunCount: 0, subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0, subscriptionOutputTokens: 0,
    }]);
    api.byAgentModel.mockResolvedValue([{
      agentId: "agent-bender", provider: "anthropic", biller: "anthropic", billingType: "api_metered",
      model: "model-breakdown-fixture", costCents: 40288, inputTokens: 62100000,
      cachedInputTokens: 200000000, outputTokens: 2000000,
    }]);
  });
  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const userReport = {
    activeUserCount: 2,
    rows: [
      { userId: "alice", userName: "Alice", userImage: null, eventCount: 2, estimatedEventCount: 1, unpricedEventCount: 0,
        costCents: 123, costCentsExact: "123.0000000", inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, runCount: 1 },
      { userId: "bob", userName: "Bob", userImage: null, eventCount: 0, estimatedEventCount: 0, unpricedEventCount: 0,
        costCents: 0, costCentsExact: "0.0000000", inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, runCount: 0 },
      { userId: null, userName: null, userImage: null, eventCount: 1, estimatedEventCount: 0, unpricedEventCount: 1,
        costCents: 0, costCentsExact: "0.0000000", inputTokens: 50, cachedInputTokens: 0, outputTokens: 10, runCount: 0 },
    ],
  };
  const userTable = () => container.querySelector<HTMLTableElement>('table[aria-label="Costs by user"]');

  it("always shows user costs below agents, with estimates, unknown prices and an empty state", async () => {
    await render();
    expect(userTable()?.textContent).toContain("No user-attributed costs yet.");
    api.byUser.mockResolvedValue(userReport);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); await settle();
    const text = container.textContent!;
    expect(text.indexOf("By agent")).toBeLessThan(text.indexOf("By user"));
    expect(text.indexOf("By user")).toBeLessThan(text.indexOf("Finance ledger"));
    expect(text).not.toContain("Inference ledger");
    expect(text).toContain("Recorded charges");
    expect(text).not.toContain("Recorded charges (net)");
    expect(text).not.toContain("Finance net");
    const rows = [...userTable()!.querySelectorAll("tbody tr")];
    expect(rows[0].querySelector('[title="Alice"]')).not.toBeNull();
    expect([...rows[0].children].slice(1).map(cell => cell.textContent)).toEqual(["1", "14040 cached", "10", "$1.23Partially estimated"]);
    expect(rows[1].textContent).toContain("$0.00");
    expect(rows[2].textContent).toContain("Unattributed");
    expect(rows[2].textContent).toContain("—1 unpriced charge");
    expect(rows[2].textContent).not.toContain("$0.00");
    api.byUser.mockResolvedValue({ activeUserCount: 1, rows: [userReport.rows[0]] });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); await settle();
    expect(userTable()?.textContent).toContain("Alice");
    expect(userTable()?.querySelectorAll("tbody tr")).toHaveLength(1);
    api.byUser.mockResolvedValue({ activeUserCount: 0, rows: [] });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); await settle();
    expect(userTable()?.textContent).toContain("No user-attributed costs yet.");
  });

  it("retains the user table on a failed refresh and clears it when the company or dates change", async () => {
    api.byUser.mockResolvedValue(userReport);
    await render();
    const table = userTable();
    api.byUser.mockRejectedValue(new Error("private user SQL diagnostic"));
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); await settle();
    expect(userTable()).toBe(table);
    expect(userTable()?.textContent).toContain("Alice");
    expect(container.textContent).toContain("User costs could not be refreshed");
    expect(container.textContent).not.toContain("private user SQL diagnostic");
    await click("7 Days");
    expect(userTable()).toBeNull();
    expect(api.byUser.mock.calls.at(-1)).toEqual(api.summary.mock.calls.at(-1));
    expect(container.textContent).toContain("User costs could not be loaded");
    expect(container.textContent).toContain("Bender");
    api.byUser.mockResolvedValue(userReport);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); await settle();
    expect(userTable()?.textContent).toContain("Alice");
    state.companyId = "company-2";
    api.byUser.mockRejectedValue(new Error("private other company error"));
    await render();
    expect(userTable()).toBeNull();
    expect(container.textContent).not.toContain("Alice");
    expect(api.byUser.mock.calls.at(-1)?.[0]).toBe("company-2");
  });

  it("keeps the existing Finance views without mounting or polling deferred accounting tools", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await render();
    for (const label of ["Recorded charges", "Finance events", "Finance ledger"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).not.toContain("Recent financial events");
    await click("Finance");
    for (const label of ["Finance ledger", "By biller", "Financial event mix", "Recent financial events"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain("API, CLI, or a supported integration");
    for (const tab of ["Providers", "Billers", "Overview", ...(name === "standalone" ? ["Budgets"] : [])]) {
      await click(tab);
      expect(container.textContent).not.toContain("Accounting health");
      expect(container.textContent).not.toContain("Record or import charges");
      expect(container.textContent).not.toContain("Open accounting tools");
    }
    if (name === "streamlined") await render({ initialTab: "budgets", lockTab: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    await settle();
    expect(container.textContent).not.toContain("Accounting health");
    expect(container.textContent).not.toContain("Record or import charges");
    expect(fetch).not.toHaveBeenCalled();
    expect(client.getQueryCache().getAll().some(query => query.queryKey[0] === "accounting")).toBe(false);
  });

  it("keeps loaded rows and expanded models through minute ticks, failed reloads, and recovery", async () => {
    await render();
    expect(container.textContent).toContain("runs: 72 api · 0 sub");
    expect(container.textContent).toContain("200.0M cached");
    const name = container.querySelector('[title="Bender"]') as HTMLElement;
    expect(name).not.toBeNull();
    await act(async () => name.click());
    expect(container.textContent).toContain("model-breakdown-fixture");
    const row = name.closest(".border");
    const firstTo = api.summary.mock.calls[0][2];
    api.summary.mockRejectedValue(new Error("private SQL error"));
    api.financeEvents.mockRejectedValue(new Error("private finance error"));
    // Flush React at the clock boundary before the next poll invokes its updated
    // query function, just as separate browser timer tasks do.
    await act(async () => { await vi.advanceTimersByTimeAsync(50_000); });
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    await settle();
    expect(container.textContent).toContain("$402.88");
    expect(container.textContent).toContain("model-breakdown-fixture");
    expect(container.querySelector('[title="Bender"]')?.closest(".border")).toBe(row);
    expect(container.textContent).toContain("Showing the last loaded data");
    expect(container.textContent).not.toContain("private");
    expect(container.querySelectorAll(".animate-pulse")).toHaveLength(0);
    expect(client.getQueryCache().getAll().filter((query) => query.queryKey[0] === "costs")).toHaveLength(2);
    expect(api.summary.mock.calls.at(-1)![2]).not.toBe(firstTo);
    api.summary.mockResolvedValue({ spendCents: 40300, budgetCents: 0, utilizationPercent: 0 });
    api.financeEvents.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();
    expect(container.textContent).toContain("$403.00");
    expect(container.textContent).not.toContain("Showing the last loaded data");
  });

  it.each(["7 Days", "30 Days"])("retains all report cache entries for %s across midnight", async (period) => {
    vi.setSystemTime(new Date(2026, 8, 29, 23, 59, 50));
    await render(); await click(period);
    await click("Providers"); await click("Billers"); await click("Overview");
    const keys = client.getQueryCache().getAll().map(q => q.queryHash).sort();
    const firstFrom = api.summary.mock.calls.at(-1)![1];
    const row = container.querySelector('[title="Bender"]')!.closest(".border");
    for (const method of ["summary", "financeEvents", "byProvider", "byBiller"]) api[method].mockRejectedValue(new Error("private failure"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000); }); await settle();
    expect(api.summary.mock.calls.at(-1)![1]).not.toBe(firstFrom);
    expect(container.textContent).toContain("$402.88");
    expect(container.querySelector('[title="Bender"]')?.closest(".border")).toBe(row);
    expect(container.textContent).toContain("Showing the last loaded data");
    expect(container.textContent).not.toContain("private failure");
    await click("Providers"); await click("Billers");
    expect(client.getQueryCache().getAll().map(q => q.queryHash).sort()).toEqual(keys);
  });

  it.each([
    ["Month to Date", "2026-09-30T23:59:50Z"],
    ["Year to Date", "2026-12-31T23:59:50Z"],
  ])("starts a new %s report at its UTC boundary", async (period, boundary) => {
    vi.setSystemTime(new Date(boundary));
    await render(); await click(period);
    expect(container.textContent).toContain("$402.88");
    const previousFrom = api.summary.mock.calls.at(-1)![1];
    api.summary.mockRejectedValue(new Error("private failure"));
    api.financeEvents.mockRejectedValue(new Error("private failure"));
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); }); await settle();
    expect(api.summary.mock.calls.at(-1)![1]).not.toBe(previousFrom);
    expect(container.textContent).not.toContain("$402.88");
    expect(container.textContent).not.toContain("Bender");
    expect(container.textContent).toContain("Cost data could not be loaded");
    expect(container.textContent).not.toContain("private failure");
  });

  it("does not reuse another company's or selected period's data after a failed initial load", async () => {
    await render();
    api.summary.mockRejectedValue(new Error("database detail must stay private"));
    await click("7 Days");
    expect(container.textContent).not.toContain("Bender");
    expect(container.textContent).not.toContain("$402.88");
    expect(container.textContent).toContain("Cost data could not be loaded");
    expect(container.textContent).not.toContain("database detail");
    await click("Month to Date");
    expect(container.textContent).toContain("Bender");
    state.companyId = "company-2";
    await render();
    expect(container.textContent).not.toContain("Bender");
    expect(container.textContent).not.toContain("$402.88");
    expect(api.summary.mock.calls.at(-1)![0]).toBe("company-2");
  });

  it("keeps inference spend visible when the finance ledger fails on first load", async () => {
    api.financeEvents.mockRejectedValue(new Error("internal finance stack trace"));
    await render();
    expect(container.textContent).toContain("Bender");
    expect(container.textContent).toContain("Financial events could not be loaded");
    expect(container.textContent).not.toContain("internal finance");
    expect(container.textContent).not.toContain("No financial events recorded");
    expect(container.textContent).not.toContain("$0.00 debits");
    expect(container.textContent).not.toContain("0 total events in range");
  });

  it("explains first-load budget failures on Overview and restores controls after polling succeeds", async () => {
    overview.mockRejectedValue(new Error("internal budget stack trace"));
    await render();
    const message = "Budget data could not be loaded. Please try again shortly.";
    const notices = () => [...container.querySelectorAll('[role="status"]')].filter(node => node.textContent === message);
    expect(notices()).toHaveLength(1);
    expect(container.querySelector('[role="tab"][data-state="active"]')?.textContent).toBe("Overview");
    expect(container.textContent).toContain("Bender");
    expect(container.textContent).not.toContain("Showing the last loaded data");
    expect(container.textContent).not.toContain("internal budget");
    expect(container.textContent).not.toContain("Raise budget & resume");
    await render({ initialTab: "budgets", lockTab: true });
    expect(container.textContent?.split(message)).toHaveLength(2);
    expect(container.textContent).not.toContain("Budget control plane");
    await render();
    overview.mockResolvedValue({
      policies: [], activeIncidents: [{ id: "incident", scopeType: "agent", scopeName: "Codie", status: "open", thresholdType: "hard", amountObserved: 200, amountLimit: 1000 }],
      pendingApprovalCount: 1, pausedAgentCount: 1, pausedProjectCount: 0,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();
    expect(notices()).toHaveLength(0);
    expect(container.textContent).toContain("Raise budget & resume");
    expect(container.textContent).toContain("Bender");
  });

  it.each(["summary", "financeEvents", "byProvider", "byBiller", "windowSpend"])("shows independent budget and stale-report notices when %s refresh fails", async (method) => {
    overview.mockRejectedValue(new Error("internal budget failure"));
    await render();
    if (method === "byProvider" || method === "windowSpend") await click("Providers");
    if (method === "byBiller") await click("Billers");
    const successfulReport = api[method].getMockImplementation()!;
    api[method].mockRejectedValue(new Error("internal report failure"));
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    expect(container.textContent).toContain("Budget data could not be loaded");
    expect(container.textContent).toContain("Showing the last loaded data");
    expect(container.textContent).toContain("$402.88");
    expect(container.textContent).not.toContain("internal");
    overview.mockResolvedValue({ policies: [], activeIncidents: [], pendingApprovalCount: 0, pausedAgentCount: 0, pausedProjectCount: 0 });
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    expect(container.textContent).not.toContain("Budget data could not be loaded");
    expect(container.textContent).toContain("Showing the last loaded data");
    api[method].mockImplementation(successfulReport);
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    expect(container.textContent).not.toContain("Showing the last loaded data");
  });

  it("retains loaded budget controls and finance totals on background errors", async () => {
    overview.mockResolvedValue({
      policies: [], activeIncidents: [{ id: "incident", scopeType: "agent", scopeName: "Codie", status: "open", thresholdType: "hard", amountObserved: 200, amountLimit: 1000 }],
      pendingApprovalCount: 1, pausedAgentCount: 1, pausedProjectCount: 0,
    });
    await render();
    const resume = [...container.querySelectorAll("button")].find(node => node.textContent === "Raise budget & resume");
    expect(resume).toBeDefined();
    overview.mockRejectedValue(new Error("internal budget failure"));
    api.financeEvents.mockRejectedValue(new Error("internal finance failure"));
    await act(async () => { await client.invalidateQueries(); });
    await settle();
    expect([...container.querySelectorAll("button")].find(node => node.textContent === "Raise budget & resume")).toBe(resume);
    expect(container.textContent).toContain("Showing the last loaded data");
    expect(container.textContent).not.toContain("Budget data could not be loaded");
    if (name === "streamlined") {
      await render({ initialTab: "budgets", lockTab: true });
      expect(container.querySelector('[role="tab"]')).toBeNull();
      expect(container.textContent).not.toContain("Inference spend");
    } else {
      await click("Budgets");
    }
    expect(container.textContent).toContain("Budget control plane");
    expect(container.textContent).not.toContain("internal budget");
    if (name === "streamlined") await render();
    await click("Finance");
    expect(container.textContent).toContain("Finance ledger");
    expect(container.textContent).toContain("0 total events in range");
    expect(container.textContent).not.toContain("internal finance");
  });

  it("retains each provider's successful quota on failure and clears it on company change", async () => {
    api.byProvider.mockResolvedValue([{
      provider: "openai", biller: "openai", billingType: "api_metered", model: "codex-fixture",
      costCents: 0, inputTokens: 100, cachedInputTokens: 0, outputTokens: 10,
      apiRunCount: 1, subscriptionRunCount: 0, subscriptionCachedInputTokens: 0,
      subscriptionInputTokens: 0, subscriptionOutputTokens: 0,
    }]);
    api.quotaWindows.mockResolvedValue([{
      provider: "openai", source: "codex-rpc", ok: true,
      windows: [{ label: "5h limit", usedPercent: 37, resetsAt: null, valueLabel: null }],
    }]);
    await render();
    await click("Providers");
    expect(container.textContent).toContain("37% used");
    api.quotaWindows.mockResolvedValue([{
      provider: "openai", ok: false, error: "Command failed: codex -a untrusted; secret", windows: [],
    }]);
    await act(async () => { await client.invalidateQueries({ queryKey: ["usage-quota-windows", "company-1"] }); });
    await settle();
    expect(container.textContent).toContain("37% used");
    expect(container.textContent).toContain("Showing the last available quota");
    expect(container.textContent).not.toContain("Command failed");
    api.quotaWindows.mockRejectedValue(new Error("gateway internal error"));
    await act(async () => { await client.invalidateQueries({ queryKey: ["usage-quota-windows", "company-1"] }); });
    await settle();
    expect(container.textContent).toContain("37% used");
    expect(container.textContent).not.toContain("gateway internal error");
    api.quotaWindows.mockResolvedValue([{
      provider: "openai", ok: false, error: "Command failed: codex", windows: [],
    }]);
    state.companyId = "company-2";
    await render();
    expect(container.textContent).not.toContain("37% used");
    expect(container.textContent).toContain("Subscription quota is currently unavailable");
  });
});
