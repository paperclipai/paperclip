// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { BudgetPolicyCard } from "./BudgetPolicyCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("exact reservation editing", () => {
  const container = document.createElement("div");
  let root: ReturnType<typeof createRoot>;
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it.each(["card", "plain"] as const)("keeps %s advanced settings collapsed and preserves exact reservation edits", async (variant) => {
    const summary: BudgetPolicySummary = {
      policyId: "policy", companyId: "company", scopeType: "company", scopeId: "company", scopeName: "Company",
      metric: "billed_cents", windowKind: "calendar_month_utc", amount: 100, observedAmount: 0,
      observedAmountExact: "0.0000000", remainingAmount: 100, utilizationPercent: 0, warnPercent: 80,
      unpricedEventCount: 0, pendingRunCount: 0, unpricedUsagePolicy: "block", reservationCents: "9007199254740992.0000001",
      hardStopEnabled: true, notifyEnabled: true, isActive: true, status: "ok", paused: false, pauseReason: null,
      windowStart: new Date("2026-09-01"), windowEnd: new Date("2026-10-01"),
    };
    const onReservationChange = vi.fn();
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<BudgetPolicyCard summary={summary} variant={variant} onReservationChange={onReservationChange} />));
    const advanced = container.querySelector("details")!;
    expect(advanced.open).toBe(false);
    expect(onReservationChange).not.toHaveBeenCalled();
    await act(async () => advanced.querySelector("summary")!.click());
    expect(advanced.open).toBe(true);
    const input = container.querySelector<HTMLInputElement>('[aria-label="Reserve per run (USD)"]')!;
    const save = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Update reservation")!;
    expect(input.value).toBe("90071992547409.920000001");
    expect(save.disabled).toBe(true);
    for (const invalid of ["-1", "", "not an amount"]) {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, invalid);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(save.disabled).toBe(true);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("Enter a valid amount of zero or more.");
      expect(input.getAttribute("aria-describedby")).toBe(container.querySelector('[role="alert"]')?.id);
    }
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "0.000000001");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => save.click());
    expect(onReservationChange).toHaveBeenCalledWith("0.0000001");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
