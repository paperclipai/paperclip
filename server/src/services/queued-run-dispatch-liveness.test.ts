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
    expect(schedule.plan(queued)).toEqual({ companyIds: [], nextAt: now + QUEUED_RUN_REDRIVE_AFTER_MS });

    const intervals: number[] = [];
    now += QUEUED_RUN_REDRIVE_AFTER_MS;
    for (let attempt = 0; attempt < 8; attempt++) {
      expect(schedule.plan(queued)).toEqual({ companyIds: ["company-a"], nextAt: now + QUEUED_RUN_REDRIVE_DELAY_MS });
      const waiting = schedule.plan(queued);
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
    expect(schedule.plan([stale])).toEqual({ companyIds: ["company-b"], nextAt: now + QUEUED_RUN_REDRIVE_DELAY_MS });
    expect(schedule.plan([])).toEqual({ companyIds: [], nextAt: null });
    now += 1;
    expect(schedule.plan([stale])).toEqual({ companyIds: ["company-b"], nextAt: now + QUEUED_RUN_REDRIVE_DELAY_MS });
  });
});
