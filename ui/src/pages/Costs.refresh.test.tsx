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
  "summary", "byAgent", "byProject", "byAgentModel", "financeSummary", "financeByBiller",
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
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === text);
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
    expect(client.getQueryCache().getAll().filter((query) => query.queryKey[0] === "costs")).toHaveLength(1);
    expect(api.summary.mock.calls.at(-1)![2]).not.toBe(firstTo);
    api.summary.mockResolvedValue({ spendCents: 40300, budgetCents: 0, utilizationPercent: 0 });
    api.financeEvents.mockResolvedValue([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    await settle();
    expect(container.textContent).toContain("$403.00");
    expect(container.textContent).not.toContain("Showing the last loaded data");
  });

  it("does not reuse another company's or selected period's data after a failed initial load", async () => {
    await render();
    api.summary.mockRejectedValue(new Error("database detail must stay private"));
    await click("Last 7 Days");
    expect(container.textContent).not.toContain("Bender");
    expect(container.textContent).not.toContain("$402.88");
    expect(container.textContent).toContain("Cost data could not be loaded");
    expect(container.textContent).not.toContain("database detail");
    await click("Month to Date (UTC)");
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

  it("retains loaded budget controls and finance totals on background errors", async () => {
    await render();
    overview.mockRejectedValue(new Error("internal budget failure"));
    api.financeEvents.mockRejectedValue(new Error("internal finance failure"));
    await act(async () => { await client.invalidateQueries(); });
    await settle();
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
