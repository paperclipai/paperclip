// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Costs } from "./Costs";
import { SidebarProvider } from "../context/SidebarContext";

const api = vi.hoisted(() => Object.fromEntries([
  "summary", "byUser", "byAgent", "byProject", "byAgentModel", "financeSummary", "financeByBiller",
  "financeByKind", "financeEvents", "byProvider", "byBiller", "windowSpend", "quotaWindows",
].map(key => [key, vi.fn()])));
vi.mock("../api/costs", () => ({ costsApi: api }));
vi.mock("../api/budgets", () => ({ budgetsApi: { overview: async () => ({ policies: [], activeIncidents: [] }) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "quota-company" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe("Costs account quota polling", () => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
  const queryKey = ["usage-quota-windows", "quota-company"];
  const observed = { provider: "openai", accountKey: "credential-one", accountLabel: "Codie account", ok: true,
    capturedAt: "2026-10-03T12:00:00Z", windows: [{ label: "5h limit", usedPercent: 37, resetsAt: null, valueLabel: null }] };
  beforeEach(() => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    for (const mock of Object.values(api)) mock.mockReset().mockResolvedValue([]);
    api.byUser.mockResolvedValue({ activeUserCount: 1, rows: [] });
    api.summary.mockResolvedValue({ spendCents: 0, budgetCents: 0 });
    api.financeSummary.mockResolvedValue({ debitCents: 0, creditCents: 0, netCents: 0, eventCount: 0 });
    api.byProvider.mockResolvedValue([{ provider: "openai", biller: "openai", model: "test", billingType: "metered_api", costCents: 0, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }]);
    api.quotaWindows.mockResolvedValue([observed]);
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); vi.unstubAllGlobals(); });
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); }); };
  it.each(["providers", "billers"] as const)("marks retained %s reports stale when their refresh fails", async (tab) => {
    api.byBiller.mockResolvedValue([{ biller: "openai", costCents: 125, eventCount: 1, providerCount: 1, inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 }]);
    await act(async () => root.render(<MemoryRouter><SidebarProvider><QueryClientProvider client={client}><Costs initialTab={tab} /></QueryClientProvider></SidebarProvider></MemoryRouter>));
    await flush();
    expect(container.textContent).not.toContain("Showing the last loaded data");
    const report = tab === "providers" ? api.byProvider : api.byBiller;
    report.mockRejectedValue(new Error("Private report diagnostic"));
    await act(async () => { await client.invalidateQueries(); }); await flush();
    expect(container.textContent).toContain("Showing the last loaded data");
    expect(container.textContent).toContain("OpenAI");
    expect(container.textContent).not.toContain("Private report diagnostic");
  });
  it("keeps quota readings with a safe notice when the endpoint rejects", async () => {
    await act(async () => root.render(<MemoryRouter><SidebarProvider><QueryClientProvider client={client}><Costs /></QueryClientProvider></SidebarProvider></MemoryRouter>));
    await flush();
    const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === "Providers")!;
    await act(async () => { tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })); tab.click(); });
    await flush();
    expect(container.textContent).toContain("37% used");
    api.quotaWindows.mockRejectedValue(new Error("Raw provider diagnostic: secret command"));
    await act(async () => { await client.invalidateQueries({ queryKey }); }); await flush();
    expect(container.textContent).toContain("37% used");
    expect(container.textContent).toContain("Showing the last available quota");
    expect(container.textContent).not.toContain("Raw provider diagnostic");
    expect(client.getQueryData(queryKey)).toMatchObject([{ capturedAt: observed.capturedAt }]);
  });
  it.each(["provider_unavailable", "permission_denied"])("retains the observation on %s but clears rejected or rotated credentials", async (errorFamily) => {
    await act(async () => root.render(<MemoryRouter><SidebarProvider><QueryClientProvider client={client}><Costs initialTab="providers" /></QueryClientProvider></SidebarProvider></MemoryRouter>));
    await flush();
    expect(container.textContent).toContain("37% used");
    api.quotaWindows.mockResolvedValue([{ ...observed, ok: false, windows: [], capturedAt: undefined, errorFamily }]);
    await act(async () => { await client.invalidateQueries({ queryKey }); }); await flush();
    expect(container.textContent).toContain("37% used");
    expect(container.textContent).toContain("Showing the last available quota");
    expect(client.getQueryData(queryKey)).toMatchObject([{ capturedAt: observed.capturedAt }]);
    api.quotaWindows.mockResolvedValue([{ ...observed, ok: false, windows: [], errorFamily: "authentication_required" }]);
    await act(async () => { await client.invalidateQueries({ queryKey }); }); await flush();
    expect(container.textContent).not.toContain("37% used");
    api.quotaWindows.mockResolvedValue([observed]);
    await act(async () => { await client.invalidateQueries({ queryKey }); }); await flush();
    api.quotaWindows.mockResolvedValue([{ ...observed, accountKey: "credential-two", ok: false, windows: [], errorFamily }]);
    await act(async () => { await client.invalidateQueries({ queryKey }); }); await flush();
    expect(container.textContent).not.toContain("37% used");
  });
});
