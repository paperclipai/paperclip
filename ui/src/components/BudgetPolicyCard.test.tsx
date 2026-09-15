// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { BudgetPolicyCard } from "./BudgetPolicyCard";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function subscriptionSummary(overrides: Partial<BudgetPolicySummary> = {}): BudgetPolicySummary {
  const amount = overrides.amount ?? 80;
  const observedAmount = overrides.observedAmount ?? 40;
  return {
    policyId: "policy-session",
    companyId: "company-1",
    scopeType: "company",
    scopeId: "company-1",
    scopeName: "Acme",
    metric: "subscription_percent",
    windowKind: "provider_session",
    amount,
    observedAmount,
    remainingAmount: amount > 0 ? Math.max(0, amount - observedAmount) : 0,
    utilizationPercent: amount > 0 ? Number(((observedAmount / amount) * 100).toFixed(2)) : 0,
    usageUnavailable: false,
    warnPercent: 80,
    hardStopEnabled: true,
    notifyEnabled: true,
    isActive: amount > 0,
    status: "ok",
    paused: false,
    pauseReason: null,
    windowStart: new Date("2026-09-13T07:00:00.000Z"),
    windowEnd: new Date("2026-09-13T12:00:00.000Z"),
    ...overrides,
  };
}

describe("BudgetPolicyCard", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(summary: BudgetPolicySummary) {
    root = createRoot(container);
    act(() => {
      root!.render(<BudgetPolicyCard summary={summary} />);
    });
    const bar = container.querySelector('[role="progressbar"]') as HTMLElement;
    const marker = container.querySelector('[data-testid="budget-limit-marker"]') as HTMLElement | null;
    const over = container.querySelector('[data-testid="budget-over-limit"]') as HTMLElement | null;
    const held = container.querySelector('[data-testid="budget-usage-held"]') as HTMLElement | null;
    return { bar, marker, over, held };
  }

  it("draws subscription usage on the whole window with a marker at the limit", () => {
    // 40% of the window used, limit at 80%: the fill is the usage itself, not
    // the 50% utilization-of-limit, so "Remaining 40%" is the visible gap.
    const { bar, marker, over } = render(subscriptionSummary({ amount: 80, observedAmount: 40 }));
    expect(bar.style.width).toBe("40%");
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("aria-label")).toBe("Window usage: 40% used, limit 80%");
    expect(marker?.style.left).toBe("calc(80% - 1px)");
    expect(marker?.getAttribute("title")).toBe("Limit 80%");
    expect(over).toBeNull();
    expect(container.textContent).toContain("Remaining");
    expect(container.textContent).toContain("40%");
    expect(container.textContent).toContain("50% of limit");
  });

  it("hatches the portion past the limit and says how far over the window is", () => {
    const { bar, marker, over } = render(
      subscriptionSummary({ amount: 50, observedAmount: 65, status: "hard_stop" }),
    );
    expect(bar.style.width).toBe("50%");
    expect(bar.className).toContain("bg-(--status-task-blocked)");
    expect(marker?.style.left).toBe("calc(50% - 1px)");
    expect(over?.style.left).toBe("50%");
    expect(over?.style.width).toBe("15%");
    expect(container.textContent).toContain("Over limit by 15%");
  });

  it("shows current window usage without a marker when no limit is configured yet", () => {
    const { bar, marker, over } = render(
      subscriptionSummary({ amount: 0, observedAmount: 72, isActive: false }),
    );
    expect(bar.style.width).toBe("72%");
    expect(bar.className).toContain("bg-muted-foreground/50");
    expect(bar.getAttribute("aria-label")).toBe("Budget utilization: 72% used");
    expect(marker).toBeNull();
    expect(over).toBeNull();
    expect(container.textContent).toContain("Unlimited");
  });

  it("keeps the last measurement, says how old it is, and reads held when a stale read sits under a limit", () => {
    // The gate never clears a run on a stale read, so under a limit the card
    // shows the hold while still drawing the last known usage and the marker.
    const observedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const { bar, marker, held } = render(
      subscriptionSummary({ amount: 80, observedAmount: 40, usageStale: true, usageObservedAt: observedAt }),
    );
    expect(bar.style.width).toBe("40%");
    expect(marker?.style.left).toBe("calc(80% - 1px)");
    expect(held).not.toBeNull();
    expect(container.textContent).toContain("40%");
    expect(container.textContent).toContain(
      "50% of limit · as of 3m ago, latest read failed; new runs wait for a fresh read",
    );
    expect(container.textContent).toContain("Runs held");
    expect(container.textContent).not.toContain("Unavailable");
    expect(container.textContent).not.toContain("Healthy");
  });

  it("shows a stale read without a limit as plain usage, nothing held", () => {
    const observedAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const { bar, held } = render(
      subscriptionSummary({ amount: 0, observedAmount: 40, isActive: false, usageStale: true, usageObservedAt: observedAt }),
    );
    expect(bar.style.width).toBe("40%");
    expect(held).toBeNull();
    expect(container.textContent).toContain("No cap configured · as of 3m ago, latest read failed");
    expect(container.textContent).not.toContain("new runs wait");
    expect(container.textContent).not.toContain("Runs held");
  });

  it("shows the limit over a hatched track and a held status when usage is unknown under a limit", () => {
    // The gate holds new runs whenever a limit cannot be checked, so the card
    // keeps the marker and reads as held, not merely unknown.
    const { bar, marker, over, held } = render(
      subscriptionSummary({ amount: 80, observedAmount: 0, usageUnavailable: true }),
    );
    expect(bar.style.width).toBe("0%");
    expect(bar.getAttribute("aria-label")).toBe("Window usage unknown, limit 80%; new runs are held");
    expect(marker?.style.left).toBe("calc(80% - 1px)");
    expect(held).not.toBeNull();
    expect(over).toBeNull();
    expect(container.textContent).toContain("Runs held");
    expect(container.textContent).toContain("Unavailable");
    expect(container.textContent).toContain("Provider did not report this window · new runs wait until it does");
    expect(container.textContent).toContain("Remaining");
    expect(container.textContent).not.toContain("Healthy");
  });

  it("renders an empty bar and an Unknown status when usage is unknown and no limit is set", () => {
    const { bar, marker, held } = render(
      subscriptionSummary({ amount: 0, observedAmount: 0, isActive: false, usageUnavailable: true }),
    );
    expect(bar.style.width).toBe("0%");
    expect(bar.getAttribute("aria-label")).toBe("Budget utilization unknown");
    expect(marker).toBeNull();
    expect(held).toBeNull();
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).not.toContain("Runs held");
    expect(container.textContent).toContain("Provider did not report this window");
    expect(container.textContent).not.toContain("new runs wait");
  });

  it("keeps money budgets as a plain utilization bar", () => {
    const { bar, marker, over } = render(
      subscriptionSummary({
        metric: "billed_cents",
        windowKind: "calendar_month_utc",
        amount: 10_000,
        observedAmount: 2_500,
        remainingAmount: 7_500,
        utilizationPercent: 25,
        usageUnavailable: undefined,
      }),
    );
    expect(bar.style.width).toBe("25%");
    expect(bar.getAttribute("aria-label")).toBe("Budget utilization: 25% used");
    expect(marker).toBeNull();
    expect(over).toBeNull();
    expect(container.textContent).toContain("$75.00");
  });
});
