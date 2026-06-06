import { describe, it, expect, vi } from "vitest";
import {
  computeReconcilerWindow,
  runReconcilerSweep,
  type ReconcilerTarget,
  type ReconcileResult,
} from "../services/pr-reconciler-sweep.js";

const zero: ReconcileResult = { enumerated: 0, linked: 0, unlinked: 0, enriched: 0 };

describe("computeReconcilerWindow", () => {
  it("derives a trailing window of exactly windowDays, until=now", () => {
    const now = new Date("2026-06-05T00:00:00Z");
    const { since, until } = computeReconcilerWindow(now, 21);
    expect(until).toBe(now);
    expect(since.toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });
});

describe("runReconcilerSweep", () => {
  const targets: ReconcilerTarget[] = [
    { companyId: "c1", repoFullName: "Blockcast/a" },
    { companyId: "c1", repoFullName: "Blockcast/b" },
  ];
  const now = new Date("2026-06-05T00:00:00Z");

  it("aggregates per-repo totals and passes the same window to every target", async () => {
    const seenWindows: string[] = [];
    const reconcile = vi.fn(async (_t: ReconcilerTarget, w: { since: Date; until: Date }) => {
      seenWindows.push(`${w.since.toISOString()}..${w.until.toISOString()}`);
      return { enumerated: 5, linked: 3, unlinked: 2, enriched: 1 };
    });

    const res = await runReconcilerSweep({ targets, now, windowDays: 21, reconcile });

    expect(res.targets).toBe(2);
    expect(res.ok).toBe(2);
    expect(res.failed).toBe(0);
    expect(res.totals).toEqual({ enumerated: 10, linked: 6, unlinked: 4, enriched: 2 });
    // Both repos reconciled against one identical window.
    expect(new Set(seenWindows).size).toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("isolates a failing repo: one throw does not abort the rest", async () => {
    const onError = vi.fn();
    const reconcile = vi.fn(async (t: ReconcilerTarget) => {
      if (t.repoFullName === "Blockcast/a") throw new Error("rate limited");
      return { enumerated: 4, linked: 4, unlinked: 0, enriched: 0 };
    });

    const res = await runReconcilerSweep({ targets, now, windowDays: 7, reconcile, onError });

    expect(res.ok).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.totals).toEqual({ enumerated: 4, linked: 4, unlinked: 0, enriched: 0 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toEqual({ companyId: "c1", repoFullName: "Blockcast/a" });
  });

  it("returns zeros for an empty target set without calling reconcile", async () => {
    const reconcile = vi.fn(async () => zero);
    const res = await runReconcilerSweep({ targets: [], now, windowDays: 21, reconcile });
    expect(res).toMatchObject({ targets: 0, ok: 0, failed: 0, totals: zero });
    expect(reconcile).not.toHaveBeenCalled();
  });
});
