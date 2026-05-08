import { describe, expect, it, vi, beforeEach } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../middleware/logger.js", () => ({ logger }));

import { runHeartbeatSchedulerCycle, startHeartbeatScheduler } from "../heartbeat-maintenance.js";

describe("runHeartbeatSchedulerCycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reconciles assigned issue wakeups during the periodic scheduler cycle", async () => {
    const heartbeat = {
      tickTimers: vi.fn().mockResolvedValue({ checked: 0, enqueued: 0, skipped: 0 }),
      reapOrphanedRuns: vi.fn().mockResolvedValue({ reaped: 0 }),
      resumeQueuedRuns: vi.fn().mockResolvedValue([]),
      reconcileAssignedIssueWakeups: vi.fn().mockResolvedValue({ checked: 2, enqueued: 1, skipped: 1 }),
    };
    const routines = {
      tickScheduledTriggers: vi.fn().mockResolvedValue({ checked: 0, triggered: 0, skipped: 0 }),
    };
    const now = new Date("2026-04-12T23:30:00.000Z");

    await runHeartbeatSchedulerCycle({ heartbeat, routines, now });

    expect(heartbeat.tickTimers).toHaveBeenCalledWith(now);
    expect(routines.tickScheduledTriggers).toHaveBeenCalledWith(now);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledWith({ staleThresholdMs: 5 * 60 * 1000 });
    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);
    expect(heartbeat.reconcileAssignedIssueWakeups).toHaveBeenCalledWith({
      requestedByActorId: "heartbeat_scheduler",
    });
    expect(logger.info).toHaveBeenCalledWith(
      { checked: 2, enqueued: 1, skipped: 1 },
      "heartbeat assigned-issue reconciliation checked dispatch gaps",
    );
  });

  it("continues reconciliation even if an earlier maintenance step fails", async () => {
    const heartbeat = {
      tickTimers: vi.fn().mockRejectedValue(new Error("tick failed")),
      reapOrphanedRuns: vi.fn().mockResolvedValue({ reaped: 0 }),
      resumeQueuedRuns: vi.fn().mockResolvedValue([]),
      reconcileAssignedIssueWakeups: vi.fn().mockResolvedValue({ checked: 1, enqueued: 0, skipped: 1 }),
    };
    const routines = {
      tickScheduledTriggers: vi.fn().mockResolvedValue({ checked: 0, triggered: 0, skipped: 0 }),
    };

    await runHeartbeatSchedulerCycle({ heartbeat, routines });

    expect(logger.error).toHaveBeenCalled();
    expect(heartbeat.reconcileAssignedIssueWakeups).toHaveBeenCalledWith({
      requestedByActorId: "heartbeat_scheduler",
    });
  });

  it("wires the live scheduler interval to the full maintenance cycle", async () => {
    const heartbeat = {
      tickTimers: vi.fn().mockResolvedValue({ checked: 0, enqueued: 0, skipped: 0 }),
      reapOrphanedRuns: vi.fn().mockResolvedValue({ reaped: 0 }),
      resumeQueuedRuns: vi.fn().mockResolvedValue([]),
      reconcileAssignedIssueWakeups: vi.fn().mockResolvedValue({ checked: 1, enqueued: 1, skipped: 0 }),
    };
    const routines = {
      tickScheduledTriggers: vi.fn().mockResolvedValue({ checked: 0, triggered: 0, skipped: 0 }),
    };
    const callbacks: Array<() => void> = [];
    const timer = {} as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn((callback: () => void, intervalMs: number) => {
      callbacks.push(callback);
      expect(intervalMs).toBe(12_345);
      return timer;
    });

    const result = startHeartbeatScheduler({
      heartbeat,
      routines,
      intervalMs: 12_345,
      setIntervalFn,
    });

    expect(result).toBe(timer);
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);
    });

    vi.clearAllMocks();
    callbacks[0]?.();

    await vi.waitFor(() => {
      expect(heartbeat.reconcileAssignedIssueWakeups).toHaveBeenCalledWith({
        requestedByActorId: "heartbeat_scheduler",
      });
    });
    expect(heartbeat.tickTimers).toHaveBeenCalledTimes(1);
    expect(routines.tickScheduledTriggers).toHaveBeenCalledTimes(1);
    expect(heartbeat.reapOrphanedRuns).toHaveBeenCalledWith({ staleThresholdMs: 5 * 60 * 1000 });
    expect(heartbeat.resumeQueuedRuns).toHaveBeenCalledTimes(1);
  });
});
