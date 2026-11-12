import { describe, expect, it } from "vitest";
import {
  createQueuedRunRedriveSchedule,
  QUEUED_RUN_REDRIVE_AFTER_MS,
  QUEUED_RUN_REDRIVE_DELAY_MS,
  QUEUED_RUN_REDRIVE_MAX_INTERVAL_MS,
  type UndispatchedQueuedRun,
} from "./queued-run-dispatch-liveness.js";

const run = (runId: string, companyId: string, createdAt: number): UndispatchedQueuedRun =>
  ({ runId, companyId, agentId: `${runId}-agent`, issueId: null, createdAt: new Date(createdAt) });

describe("queued run re-drive schedule", () => {
  it("waits out the bound, then re-drives with a doubling interval up to the cap", () => {
    let now = 1_000_000;
    const schedule = createQueuedRunRedriveSchedule(() => now);
    const queued = [run("a", "company-a", now)];
    expect(schedule.refresh("all", queued)).toEqual({ companyIds: [], nextAt: now + QUEUED_RUN_REDRIVE_AFTER_MS });

    const intervals: number[] = [];
    now += QUEUED_RUN_REDRIVE_AFTER_MS;
    for (let attempt = 0; attempt < 8; attempt++) {
      expect(schedule.refresh("all", queued)).toEqual({ companyIds: ["company-a"], nextAt: now + QUEUED_RUN_REDRIVE_DELAY_MS });
      const waiting = schedule.refresh("all", queued);
      expect(waiting.companyIds).toEqual([]);
      intervals.push(waiting.nextAt! - now);
      now = waiting.nextAt!;
    }
    expect(intervals.slice(0, 4)).toEqual([1, 2, 4, 8].map(factor => factor * QUEUED_RUN_REDRIVE_AFTER_MS));
    expect(Math.max(...intervals)).toBe(QUEUED_RUN_REDRIVE_MAX_INTERVAL_MS);
  });

  it("goes quiet once nothing is left undispatched and starts over for a run that returns", () => {
    let now = 5_000_000;
    const schedule = createQueuedRunRedriveSchedule(() => now);
    const stale = run("stale", "company-b", now - 10 * QUEUED_RUN_REDRIVE_AFTER_MS);
    expect(schedule.refresh("all", [stale])).toEqual({ companyIds: ["company-b"], nextAt: now + QUEUED_RUN_REDRIVE_DELAY_MS });
    expect(schedule.refresh("all", [])).toEqual({ companyIds: [], nextAt: null });
    now += 1;
    expect(schedule.refresh("all", [stale])).toEqual({ companyIds: ["company-b"], nextAt: now + QUEUED_RUN_REDRIVE_DELAY_MS });
  });

  it("refreshes only the companies a pass read and keeps every other company's runs due", () => {
    const now = 9_000_000;
    const schedule = createQueuedRunRedriveSchedule(() => now);
    const held = run("held", "company-held", now - 30_000);
    const stranded = run("stranded", "company-stranded", now - 30_000);
    expect(schedule.refresh("all", [held, stranded]).nextAt).toBe(now + 30_000);
    expect(schedule.refresh(new Set(["company-held"]), [])).toEqual({ companyIds: [], nextAt: now + 30_000 });
    expect(schedule.refresh(new Set(["company-stranded"]), [])).toEqual({ companyIds: [], nextAt: null });
  });
});
