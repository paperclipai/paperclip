// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appearanceForPalette, agentAvatarUrl, type CostDataQualityItem, type CostDataQualityReason, type CostDataQualityReport } from "@paperclipai/shared";
import { ToastProvider, useToastState } from "../context/ToastContext";
import { ApiError } from "../api/client";
import { CostDataQualityNotice } from "./CostDataQualityNotice";

const mocks = vi.hoisted(() => ({ dataQuality: vi.fn(), retryAccounting: vi.fn(), runSettlement: vi.fn(), settleRun: vi.fn() }));
vi.mock("../api/costs", () => ({ costsApi: mocks }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { issuePrefix: "PAP" } }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const key = ["costs", "company", "2026-10-01", "2026-10-09"];
function item(reason: CostDataQualityReason): CostDataQualityItem {
  return { id: reason, runId: `${reason}-run`, agentId: "codie", agentName: "Codie", occurredAt: "2026-10-09T12:00:00Z", provider: "openai", model: "gpt-6-astra", reason };
}
function report(canRetry = true): CostDataQualityReport {
  return { canRetry, events: [item("unknown_billing"), item("missing_model"), item("missing_price")],
    runs: [item("waiting_for_receipt"), item("receipt_unavailable"), item("retryable")], hasMoreEvents: false, hasMoreRuns: false };
}
/** An owner's report in which the endpoint accepts the unavailable run. */
function settleableReport(): CostDataQualityReport {
  const base = report();
  return { ...base, canSettle: true,
    runs: base.runs.map(run => run.reason === "receipt_unavailable" ? { ...run, settleable: true } : run) };
}
function ToastStatus() {
  const toasts = useToastState();
  return <div aria-label="Notifications">{toasts.map(toast => <p role="status" key={toast.id}>{toast.title} {toast.body}</p>)}</div>;
}
describe("actionable cost notices", () => {
  let container: HTMLDivElement, root: ReturnType<typeof createRoot>, client: QueryClient;
  beforeEach(() => {
    vi.resetAllMocks(); mocks.dataQuality.mockResolvedValue(report()); mocks.retryAccounting.mockResolvedValue({ accounted: true });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
  async function render(counts: { unpricedCount?: number; pendingCount?: number; unknownBillingCount?: number } = {}) {
    await act(async () => root.render(<MemoryRouter initialEntries={["/PAP/activity/costs"]}><QueryClientProvider client={client}><ToastProvider><ToastStatus />
      <CostDataQualityNotice companyId="company" from="2026-10-01" to="2026-10-09" reportKey={key} unpricedCount={12} pendingCount={4} unknownBillingCount={9} {...counts} />
    </ToastProvider></QueryClientProvider></MemoryRouter>));
  }
  function button(text: string) { return [...container.querySelectorAll("button")].find(button => button.textContent === text)!; }
  async function click(text: string) { await act(async () => button(text).click()); }
  async function loaded() { await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Ready to record"))); }

  it("loads bounded details only on demand using the displayed period", async () => {
    await render(); expect(mocks.dataQuality).not.toHaveBeenCalled();
    expect(button("16 run costs unavailable").getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toBe("16 run costs unavailable");
    expect(container.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await click("16 run costs unavailable"); await loaded();
    expect(mocks.dataQuality).toHaveBeenCalledExactlyOnceWith("company", "2026-10-01", "2026-10-09");
    expect(button("16 run costs unavailable").getAttribute("aria-expanded")).toBe("true");
    const details = document.getElementById(button("16 run costs unavailable").getAttribute("aria-controls")!)!;
    expect(details.textContent).not.toContain("Totals include known charges only.");
    expect(details.textContent).not.toContain("12 entries without prices · 4 runs without final cost data · 9 entries with unknown billing");
    expect(details.textContent).not.toContain("Includes 12 estimated charges.");
    await click("16 run costs unavailable");
    expect(container.querySelector("ul")).toBeNull();
    expect(container.textContent).toBe("16 run costs unavailable");
  });

  it("explains future configuration fixes and links to the affected runs in the active company", async () => {
    await render(); await click("16 run costs unavailable"); await loaded();
    const row = (label: string) => [...container.querySelectorAll('[data-slot="badge"]')].find(badge => badge.textContent === label)!.closest("li")!;
    const billing = row("Billing category unknown");
    expect(billing.textContent).toContain("Any recorded charges are included in the inference ledger.");
    const configuration = container.querySelector('a[href="/PAP/agents/codie/configuration"]')!;
    expect(configuration.textContent).toBe("Codie");
    expect(configuration.closest("h3")!.textContent).toBe("Codie");
    expect(container.querySelectorAll('a[href="/PAP/agents/codie/configuration"]')).toHaveLength(1);
    expect(billing.querySelector('a[href="/PAP/agents/codie/configuration"]')).toBeNull();
    expect(billing.querySelector('a[href="/PAP/agents/codie/runs/unknown_billing-run"]')).not.toBeNull();
    for (const link of container.querySelectorAll("a")) expect(link.hasAttribute("data-slot")).toBe(false);
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="agent-avatar"]')).toHaveLength(1);
    expect(container.textContent).toContain("Changing settings will not reprice this past run.");
    const runs = [row("Receiving usage"), row("Final usage unavailable")];
    expect(runs[0].textContent).toContain("You do not need to rerun the agent.");
    expect(runs[1].textContent).toContain("Its cost remains unresolved for budget checks.");
    expect(runs[1].textContent).toContain("rerunning the agent will not recover this usage.");
    expect(runs[0].querySelector("button")).toBeNull();
    expect(runs[1].querySelector("button")).toBeNull();
    expect([...container.querySelectorAll("button")].filter(row => row.textContent === "Retry cost recording")).toHaveLength(1);
    const actionLine = button("Retry cost recording").parentElement!;
    expect(actionLine.children[0].tagName).toBe("TIME");
    expect(actionLine.children[1].textContent).toBe("View run");
    expect(actionLine.children[2].textContent).toBe("Retry cost recording");
    expect(button("Retry cost recording").getAttribute("data-variant")).toBe("link");
  });

  it("groups all kinds of cost gaps by agent identity, alphabetizes names, and preserves appearances and newest-first entries", async () => {
    const appearance = appearanceForPalette("deep-tide");
    mocks.dataQuality.mockResolvedValue({ canRetry: true, hasMoreEvents: false, hasMoreRuns: false,
      events: [
        { ...item("missing_model"), agentId: "fry", agentName: "fry" },
        { ...item("missing_price"), id: "shared-id", agentAppearance: appearance, occurredAt: "2026-10-08T12:00:00Z" },
        { ...item("unknown_billing"), agentId: null, agentName: null, runId: null },
        { ...item("missing_price"), id: "other-codie", agentId: "codie-2" },
      ],
      runs: [
        { ...item("receipt_unavailable"), agentId: "leela", agentName: "Leela" },
        { ...item("retryable"), id: "shared-id", agentAppearance: appearance },
      ],
    });
    await render(); await click("16 run costs unavailable"); await loaded();
    const groups = [...container.querySelectorAll('[aria-label="Cost details by agent"] > li')];
    expect(groups.map(group => group.querySelector("h3")!.textContent)).toEqual(["Codie", "Codie", "fry", "Leela", "Paperclip services"]);
    const codieItems = groups[0].querySelectorAll("li");
    expect(codieItems).toHaveLength(2);
    expect(codieItems[0].textContent).toContain("Ready to record");
    expect(codieItems[1].textContent).toContain("Cost unavailable");
    expect(groups[1].querySelectorAll("li")).toHaveLength(1);
    expect(groups[0].querySelector("img")?.getAttribute("src")).toBe(agentAvatarUrl(appearance, 20));
    expect(groups[4].querySelector("a")).toBeNull();
  });

  it("does not label priced unknown billing or estimates as unavailable costs", async () => {
    await render({ unpricedCount: 0, pendingCount: 0, unknownBillingCount: 1 });
    expect(container.textContent).toBe("1 billing type unknown");
    await click("1 billing type unknown"); await loaded();
    expect(container.textContent).toContain("Billing category unknown");
    expect(container.textContent).not.toContain("Totals include known charges only.");
    expect(container.textContent).not.toContain("Includes 12 estimated charges.");
  });

  it("records saved costs without rerunning work and refreshes every period for this company", async () => {
    let finish!: (result: { accounted: boolean }) => void;
    mocks.retryAccounting.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await render(); await click("16 run costs unavailable"); await loaded();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await click("Retry cost recording");
    await act(async () => vi.waitFor(() => expect(button("Retry cost recording").disabled).toBe(true)));
    await click("Retry cost recording");
    expect(mocks.retryAccounting).toHaveBeenCalledTimes(1);
    await act(async () => finish({ accounted: true }));
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Costs recorded.")));
    expect(mocks.retryAccounting).toHaveBeenCalledExactlyOnceWith("company", "retryable-run");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["costs", "company"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["cost-subscriptions", "company"] });
  });

  it("keeps retry confirmation after the refreshed report removes the run and the notice unmounts", async () => {
    mocks.dataQuality.mockResolvedValueOnce({ ...report(), events: [], runs: [item("retryable")] })
      .mockResolvedValue({ ...report(), events: [], runs: [] });
    await render({ unpricedCount: 0, pendingCount: 1, unknownBillingCount: 0 });
    await click("1 run cost unavailable"); await loaded();
    await click("Retry cost recording");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("No cost gaps remain")));
    expect(container.textContent).not.toContain("Retry cost recording");
    await act(async () => root.render(<MemoryRouter><QueryClientProvider client={client}>
      <ToastProvider><ToastStatus /></ToastProvider>
    </QueryClientProvider></MemoryRouter>));
    expect(container.textContent).toContain("Costs recorded. The agent was not rerun.");
  });

  it("makes stale retry results understandable and never renders raw provider errors", async () => {
    mocks.retryAccounting.mockResolvedValueOnce({ accounted: false }).mockRejectedValueOnce(new Error("SECRET sh -c provider --token credential"));
    await render(); await click("16 run costs unavailable"); await loaded();
    await click("Retry cost recording");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("No new cost data is available. The agent was not rerun.")));
    await click("Retry cost recording");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Cost recording failed. Try again shortly.")));
    expect(container.textContent).not.toContain("SECRET");
    expect(container.textContent).not.toContain("credential");
  });

  it("keeps viewer details readable without exposing the retry action", async () => {
    mocks.dataQuality.mockResolvedValue(report(false));
    await render(); await click("16 run costs unavailable"); await loaded();
    expect(container.textContent).not.toContain("Retry cost recording");
    expect(mocks.retryAccounting).not.toHaveBeenCalled();
  });

  it("retains the last successful details through a failed background refresh", async () => {
    await render(); await click("16 run costs unavailable"); await loaded();
    mocks.dataQuality.mockRejectedValue(new Error("SECRET backend exception"));
    await act(async () => { await client.invalidateQueries({ queryKey: [...key, "data-quality"] }); });
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Showing the last loaded cost details.")));
    expect(container.textContent).toContain("Ready to record");
    expect(container.textContent).not.toContain("SECRET");
  });

  it("offers a safe first-load retry and explains truncated results", async () => {
    mocks.dataQuality.mockRejectedValueOnce(new Error("SECRET command"));
    await render(); await click("16 run costs unavailable");
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Cost details could not be loaded.")));
    expect(container.textContent).not.toContain("SECRET");
    mocks.dataQuality.mockResolvedValue({ ...report(), hasMoreRuns: true });
    await click("Retry loading"); await loaded();
    expect(container.textContent).toContain("Select a shorter date range to inspect more.");
  });

  it("offers owners an explicit estimate settlement for a run whose final usage is unavailable", async () => {
    const revision = "b".repeat(64);
    mocks.dataQuality.mockResolvedValue(settleableReport());
    mocks.runSettlement.mockResolvedValue({ runId: "receipt_unavailable-run", agentId: "codie", status: "interrupted",
      finishedAt: "2026-10-09T12:00:00Z", provider: "deepseek", model: "deepseek-chat", billingType: "metered_api",
      inputTokens: 1200, cachedInputTokens: 300, outputTokens: 200, recordedCents: "150.0000000",
      reservedCents: "400.0000000", proposedCents: "180.0000000", revision });
    mocks.settleRun.mockResolvedValue({ accounted: true, settledBy: "owner_estimate" });
    await render(); await click("16 run costs unavailable"); await loaded();
    expect([...container.querySelectorAll("button")].filter(row => row.textContent === "Settle with an estimate")).toHaveLength(1);
    const unavailable = [...container.querySelectorAll('[data-slot="badge"]')].find(badge => badge.textContent === "Final usage unavailable")!.closest("li")!;
    expect(unavailable.textContent).toContain("Settle with an estimate");
    await click("Settle with an estimate");
    const dialog = () => document.body.querySelector('[role="dialog"]')!;
    await act(async () => vi.waitFor(() => expect(dialog().textContent).toContain("1,200 input · 300 cached · 200 output")));
    expect(mocks.runSettlement).toHaveBeenCalledExactlyOnceWith("company", "receipt_unavailable-run");
    for (const text of ["deepseek · deepseek-chat", "$1.50", "$4.00", "$1.80", "may have used more than Paperclip recorded",
      "The estimate is not a provider charge", "kept for review instead of being charged again"]) expect(dialog().textContent).toContain(text);
    const settleButton = () => [...dialog().querySelectorAll("button")].find(button => button.textContent?.startsWith("Settle at"))!;
    expect(settleButton().textContent).toBe("Settle at $1.80");
    expect(settleButton().disabled).toBe(true);
    const field = (label: string) => dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(
      [...dialog().querySelectorAll("label")].find(item => item.textContent === label)!.htmlFor)}`)!;
    const type = async (element: HTMLInputElement | HTMLTextAreaElement, value: string) => act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")!.set!;
      setter.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await type(field("Estimated cost (USD)") as HTMLInputElement, "1.49");
    expect(dialog().textContent).toContain("Enter at least $1.50, the cost Paperclip already recorded.");
    await type(field("Estimated cost (USD)") as HTMLInputElement, "2.25");
    await type(field("Reason"), "Provider console shows $2.25");
    expect(settleButton().disabled).toBe(true);
    await act(async () => dialog().querySelector<HTMLButtonElement>('[role="checkbox"]')!.click());
    expect(settleButton().disabled).toBe(false);
    await act(async () => settleButton().click());
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Run cost settled.")));
    expect(mocks.settleRun).toHaveBeenCalledExactlyOnceWith("company", "receipt_unavailable-run", { idempotencyKey: expect.any(String),
      expectedRevision: revision, estimatedCents: "225.0000000", reason: "Provider console shows $2.25", confirmStopped: true });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("hides estimate settlement from anyone who is not a company owner", async () => {
    mocks.dataQuality.mockResolvedValue({ ...settleableReport(), canSettle: false });
    await render(); await click("16 run costs unavailable"); await loaded();
    expect(container.textContent).not.toContain("Settle with an estimate");
    // Other members still learn that an owner can resolve it.
    expect(container.textContent).toContain("A company owner can settle it with an estimate.");
    expect(mocks.runSettlement).not.toHaveBeenCalled();
  });

  it("offers owners no settlement the server would refuse", async () => {
    // Final usage is unavailable, but the run is not settleable: for example,
    // native recovery may still run its provider again.
    mocks.dataQuality.mockResolvedValue({ ...report(), canSettle: true });
    await render(); await click("16 run costs unavailable"); await loaded();
    expect(container.textContent).toContain("Final usage unavailable");
    expect(container.textContent).not.toContain("Settle with an estimate");
    expect(container.textContent).not.toContain("A company owner can settle it with an estimate.");
  });

  it("reloads the review after a stale-revision conflict and waits for a fresh decision", async () => {
    const reviewed = { runId: "receipt_unavailable-run", agentId: "codie", status: "interrupted",
      finishedAt: "2026-10-09T12:00:00Z", provider: "deepseek", model: "deepseek-chat", billingType: "metered_api",
      inputTokens: 1200, cachedInputTokens: 300, outputTokens: 200, recordedCents: "150.0000000",
      reservedCents: "400.0000000", proposedCents: "180.0000000", revision: "b".repeat(64) };
    const current = { ...reviewed, outputTokens: 900, recordedCents: "260.0000000", proposedCents: "300.0000000",
      revision: "c".repeat(64) };
    mocks.dataQuality.mockResolvedValue(settleableReport());
    mocks.runSettlement.mockResolvedValueOnce(reviewed).mockResolvedValueOnce(current);
    mocks.settleRun.mockRejectedValueOnce(new ApiError("This run's usage changed since review. Review it again.", 409, {}))
      .mockResolvedValueOnce({ accounted: true, settledBy: "owner_estimate" });
    await render(); await click("16 run costs unavailable"); await loaded();
    await click("Settle with an estimate");
    const dialog = () => document.body.querySelector('[role="dialog"]')!;
    const settleButton = () => [...dialog().querySelectorAll("button")].find(button => button.textContent?.startsWith("Settle"))!;
    const checkbox = () => dialog().querySelector<HTMLButtonElement>('[role="checkbox"]')!;
    const reason = () => dialog().querySelector("textarea")!;
    await act(async () => vi.waitFor(() => expect(dialog().textContent).toContain("200 output")));
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(reason(), "Provider console");
      reason().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => checkbox().click());
    await act(async () => settleButton().click());

    // The dialog loads the run's current usage instead of resubmitting.
    await act(async () => vi.waitFor(() => expect(dialog().textContent).toContain("900 output")));
    expect(mocks.runSettlement).toHaveBeenCalledTimes(2);
    expect(mocks.settleRun).toHaveBeenCalledOnce();
    for (const text of ["$2.60", "usage changed since review", "The figures above are current. Review them and settle again."])
      expect(dialog().textContent).toContain(text);
    expect(settleButton().textContent).toBe("Settle at $3.00");
    expect(checkbox().getAttribute("aria-checked")).toBe("false");
    expect(settleButton().disabled).toBe(true);
    expect(reason().value).toBe("Provider console");
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
    expect(mocks.settleRun).toHaveBeenCalledOnce();

    await act(async () => checkbox().click());
    await act(async () => settleButton().click());
    await act(async () => vi.waitFor(() => expect(container.textContent).toContain("Run cost settled.")));
    const [[, , first], [, , second]] = mocks.settleRun.mock.calls;
    expect(first).toMatchObject({ expectedRevision: "b".repeat(64), estimatedCents: "180.0000000" });
    expect(second).toMatchObject({ expectedRevision: "c".repeat(64), estimatedCents: "300.0000000",
      reason: "Provider console", confirmStopped: true });
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  });
});
