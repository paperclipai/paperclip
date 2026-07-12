import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

const run = (errorCode: string | null) =>
  ({ errorCode } as unknown as Parameters<typeof classifyContinuationFailure>[0]);

// Mirror of the backoff math in service.ts (requiredDelay = base * 2^(consecutive-1))
// used only to assert the escalation window, not to couple to internals.
function cumulativeWindowMs(base: number, maxAttempts: number): number {
  let total = 0;
  for (let consecutive = 1; consecutive < maxAttempts; consecutive += 1) {
    total += base * Math.pow(2, consecutive - 1);
  }
  return total;
}

describe("worktree-swap continuation classification", () => {
  it("skills_source_unavailable is retryable transient_infra", () => {
    const c = classifyContinuationFailure(run("skills_source_unavailable"));
    expect(c.kind).toBe("transient_infra");
    expect(c.maxAttempts).toBeGreaterThan(0);
    expect(c.errorCode).toBe("skills_source_unavailable");
  });

  it("backs off across the full ~18-20 min swap window before escalating to blocked", () => {
    const c = classifyContinuationFailure(run("skills_source_unavailable"));
    // The last retry must land past the measured swap window (~18 min) so a run
    // that dies mid-swap is retried after the swap completes, not false-blocked.
    const window = cumulativeWindowMs(c.baseBackoffMs, c.maxAttempts);
    expect(window).toBeGreaterThanOrEqual(20 * 60_000);
  });

  it("uses a longer window than the generic 60s×3 transient backoff", () => {
    const swap = classifyContinuationFailure(run("skills_source_unavailable"));
    const generic = classifyContinuationFailure(run("adapter_failed"));
    const swapWindow = cumulativeWindowMs(swap.baseBackoffMs, swap.maxAttempts);
    const genericWindow = cumulativeWindowMs(generic.baseBackoffMs, generic.maxAttempts);
    expect(swapWindow).toBeGreaterThan(genericWindow);
    // Sanity: the generic path is exactly the ~3 min that motivated this fix.
    expect(genericWindow).toBe(180_000);
  });

  it("generic adapter_failed keeps its existing 60s×3 backoff (no regression)", () => {
    const c = classifyContinuationFailure(run("adapter_failed"));
    expect(c.kind).toBe("transient_infra");
    expect(c.baseBackoffMs).toBe(60_000);
    expect(c.maxAttempts).toBe(3);
  });
});
