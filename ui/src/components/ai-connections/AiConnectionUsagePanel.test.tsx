// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AiManagedConnectionSummary, AiConnectionUsage } from "@paperclipai/shared";
import { AiConnectionUsagePanel } from "./AiConnectionUsagePanel";

const api = vi.hoisted(() => ({ probeUsage: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));
const account: AiManagedConnectionSummary = { id: "connection", grantId: "grant", companyId: "company", provider: "anthropic", method: "subscription", name: "My Claude", ownership: "personal", isDefault: true, status: "connected" };
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let client: QueryClient;
beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { flushSync(() => root.unmount()); client.clear(); host.remove(); });
function render(value = account) {
  flushSync(() => root.render(<QueryClientProvider client={client}><AiConnectionUsagePanel key={value.id} account={value} /></QueryClientProvider>));
}
const click = () => flushSync(() => host.querySelector("button")!.click());
it("checks only on demand and replaces a successful observation with a failed probe", async () => {
  const observation: AiConnectionUsage = { ...account, connectionId: account.id, status: "ok", checkedAt: "2026-10-02T12:00:00Z", source: "anthropic_oauth", planType: null,
    overage: { enabled: false, available: false, unlimited: null, used: null, limit: null, remaining: null, balance: null, unit: "cents" },
    limits: [{ id: "five_hour", label: "5 hour limit", scope: null, windowDurationSeconds: 18000, resetsAt: null,
      usedPercent: 100, remainingPercent: 0, used: null, limit: null, remaining: null, unit: "percent", limitReached: true, allowed: null }],
  };
  api.probeUsage.mockResolvedValue(observation);
  render();
  expect(api.probeUsage).not.toHaveBeenCalled();
  click();
  await vi.waitFor(() => expect(host.textContent).toContain("100% used"));
  expect(api.probeUsage).toHaveBeenCalledWith("company", "connection", "grant");
  expect(host.textContent).toContain("Limit reached");
  expect(host.textContent).toContain("OverageOff");
  expect(host.textContent).not.toContain("remaining");
  expect(host.textContent).not.toContain("hour window");
  api.probeUsage.mockResolvedValue({ ...observation, status: "error", limits: [], overage: null, message: "The provider rate limited the usage check. Try again later." });
  click();
  await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain("rate limited"));
  expect(host.textContent).not.toContain("100% used");
  expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
});
it("clears the prior account's snapshot when changing accounts", async () => {
  api.probeUsage.mockResolvedValue({ status: "error", message: "Old account failure" });
  render(); click();
  await vi.waitFor(() => expect(host.textContent).toContain("Old account failure"));
  render({ ...account, id: "other", grantId: "other-grant" });
  expect(host.textContent).not.toContain("Old account failure");
  expect(api.probeUsage).toHaveBeenCalledTimes(1);
});
it("does not round almost-exhausted usage up to an exhausted allowance", async () => {
  api.probeUsage.mockResolvedValue({ status: "ok", checkedAt: "2026-10-02T12:00:00Z", overage: { balance: 0.00001, unit: "USD" },
    limits: [{ id: "five_hour", label: "5 hour limit", usedPercent: 99.99999, remainingPercent: 0.00001,
      limitReached: false, allowed: null, windowDurationSeconds: 18000, resetsAt: null, limit: 1, remaining: 0.0000001, unit: "USD" }],
  });
  render(); click();
  await vi.waitFor(() => expect(host.textContent).toContain("99.99999% used"));
  expect(host.textContent).not.toContain("0.00001% remaining");
  expect(host.textContent).toContain("$0.0000001 left");
  expect(host.textContent).toContain("$0.00001");
  expect(host.textContent).not.toContain("Limit reached");
});
it("explains unsupported methods and disables checks for a revoked grant", () => {
  render({ ...account, method: "api_key" });
  expect(host.textContent).toContain("Unavailable for this sign-in method");
  expect(host.querySelector("button")).toBeNull();
  render({ ...account, status: "revoked" });
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(api.probeUsage).not.toHaveBeenCalled();
});
it("keeps provider admission and unknown overage availability distinct from exhaustion", async () => {
  api.probeUsage.mockResolvedValue({ status: "ok", checkedAt: "2026-10-02T12:00:00Z",
    overage: { enabled: true, available: null, unlimited: null, balance: null, remaining: null },
    limits: [{ id: "primary", label: "Plan usage · Primary", windowDurationSeconds: 18000, usedPercent: 100,
      remainingPercent: 0, limitReached: true, allowed: true, resetsAt: null, used: null, limit: null, remaining: null, unit: "percent" }],
  });
  render(); click();
  await vi.waitFor(() => expect(host.textContent).toContain("Limit reached · Usage allowed"));
  expect(host.textContent).toContain("Plan usage · Primary · 5h");
  expect(host.textContent).toContain("On · Availability unknown");
  expect(host.textContent).not.toContain("Provider denies");
});
it("shows explicit denial and distinguishes equal-duration provider windows", async () => {
  const window = { scope: null, windowDurationSeconds: 18000, resetsAt: null, used: null, limit: null, remaining: null, unit: "percent" };
  api.probeUsage.mockResolvedValue({ status: "ok", checkedAt: "2026-10-02T12:00:00Z", overage: null,
    limits: [
      { ...window, id: "primary", label: "Plan usage · Primary", usedPercent: 100, remainingPercent: 0, limitReached: true, allowed: false },
      { ...window, id: "secondary", label: "Plan usage · Secondary", usedPercent: 50, remainingPercent: 50, limitReached: false, allowed: true },
    ],
  });
  render(); click();
  await vi.waitFor(() => expect(host.textContent).toContain("Blocked"));
  expect(host.querySelector('[aria-label="Plan usage · Primary · 5h: 100%"]')).not.toBeNull();
  expect(host.querySelector('[aria-label="Plan usage · Secondary · 5h: 50%"]')).not.toBeNull();
});

it("shows cached pool observations without offering or making a provider call", () => {
  const observation: AiConnectionUsage = { connectionId: account.id, grantId: account.grantId, provider: account.provider, method: account.method, status: "ok", checkedAt: "2026-10-02T12:00:00Z", source: "fixture", planType: null, limits: [], overage: null };
  flushSync(() => root.render(<QueryClientProvider client={client}><AiConnectionUsagePanel account={account} observation={observation} cachedOnly /></QueryClientProvider>));
  expect(host.textContent).toContain("Usage not reported");
  expect(host.querySelector("button")).toBeNull();
  expect(api.probeUsage).not.toHaveBeenCalled();
});
