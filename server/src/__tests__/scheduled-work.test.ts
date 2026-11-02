import { PgDialect } from "drizzle-orm/pg-core";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerScheduledWork } from "../services/scheduled-work.js";
import { idleWorkSnapshot, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  stopTaskDrain();
  vi.useRealTimers();
});

function fixture(input: { routine?: number | null; monitor?: number | null; tickIssueMonitors?: () => Promise<void>; tickRoutines?: () => Promise<void> } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2020-01-01T00:00:00.000Z"));
  const dialect = new PgDialect();
  const deadlines = { routine: input.routine ?? null, monitor: input.monitor ?? null };
  let canRun = true;
  let canReconcile = true;
  let failRead = false;
  const execute = vi.fn(async (query: any) => {
    const compiled = dialect.sqlToQuery(query);
    const text = compiled.sql;
    if (text.includes("pg_current_xact_id")) return [{ xid: "42" }];
    if (failRead) throw new Error("database unavailable");
    throw new Error(`Unexpected database query: ${text}`);
  });
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: any) => Promise<any>) {
    return callback({ execute, transaction: owner.transaction });
  } });
  const errors = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => canRun, canReconcile: () => canReconcile, onError: errors });
  coordinators.push(coordinator);
  const tickIssueMonitors = vi.fn(input.tickIssueMonitors ?? (async () => {
    if (deadlines.monitor !== null && deadlines.monitor <= Date.now()) deadlines.monitor = null;
  }));
  const tickAgentTimers = vi.fn(async () => {});
  const nextIssueMonitorAt = vi.fn(async () => {
    if (failRead) throw new Error("database unavailable");
    return deadlines.monitor;
  });
  const tickRoutines = vi.fn(input.tickRoutines ?? (async () => {
    if (deadlines.routine !== null && deadlines.routine <= Date.now()) deadlines.routine = null;
  }));
  const nextRoutineRunAt = vi.fn(async () => {
    if (failRead) throw new Error("database unavailable");
    return deadlines.routine;
  });
  const workers = registerScheduledWork(coordinator,
    { retryMs: 60_000, nextAgentTimerAt: async () => null, tickAgentTimers, tickIssueMonitors, nextIssueMonitorAt, tickRoutines, nextRoutineRunAt, canRun: () => canRun });
  return { coordinator, workers, owner, deadlines, execute, nextRoutineRunAt, nextIssueMonitorAt, tickAgentTimers, tickIssueMonitors, tickRoutines, errors,
    ready: () => Promise.all([workers.routines.ready, workers.monitors.ready, workers.timers.ready]),
    canRun: (value: boolean) => { canRun = value; }, canReconcile: (value: boolean) => { canReconcile = value; }, failRead: (value: boolean) => { failRead = value; } };
}

describe("scheduled routine and monitor deadlines", () => {
  it.each(["run", "deadline read"])("retains a monitor pass interrupted during %s by a maintenance drain", async boundary => {
    const f = fixture({ tickIssueMonitors: async () => { if (boundary === "run") startTaskDrain(); } });
    if (boundary === "deadline read") f.nextIssueMonitorAt.mockImplementationOnce(async () => { startTaskDrain(); return null; });
    await f.ready();
    expect(f.coordinator.nextWakeAt()).not.toBeNull();
    expect(f.nextIssueMonitorAt).toHaveBeenCalledTimes(boundary === "run" ? 0 : 1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.tickIssueMonitors).toHaveBeenCalledOnce();
    f.tickIssueMonitors.mockImplementation(async () => {});
    stopTaskDrain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.tickIssueMonitors).toHaveBeenCalledTimes(2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });

  it("bounds notification scans to the configured cadence while preserving known deadlines", async () => {
    const origin = Date.UTC(2020, 0, 1);
    const f = fixture({ monitor: origin + 150_000 });
    await f.ready();
    for (let second = 0; second < 120; second++) {
      await f.owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors));
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(f.nextIssueMonitorAt).toHaveBeenCalledTimes(3);
    expect(f.tickIssueMonitors).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.tickIssueMonitors).toHaveBeenCalledTimes(4);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.nextIssueMonitorAt).toHaveBeenCalledTimes(4);
  });

  it("legacy agent timer wakes do not query or dispatch issue monitors", async () => {
    const f = fixture();
    await f.ready();
    const before = f.nextIssueMonitorAt.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      f.workers.timers.wake();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(f.tickAgentTimers).toHaveBeenCalledTimes(6);
    expect(f.tickIssueMonitors).toHaveBeenCalledTimes(1);
    expect(f.nextIssueMonitorAt).toHaveBeenCalledTimes(before);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });

  it("dispatches at each saved deadline without waiting for a periodic tick", async () => {
    const now = Date.UTC(2020, 0, 1);
    const f = fixture({ routine: now + 10_000, monitor: now + 20_000 });
    await f.ready();
    expect(f.coordinator.nextWakeAt()).toBe(now + 10_000);
    expect(idleWorkSnapshot().active).toBe(0);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.tickRoutines).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.tickRoutines).toHaveBeenCalledTimes(2);
    expect(f.tickIssueMonitors).toHaveBeenCalledTimes(1);
    expect(f.coordinator.nextWakeAt()).toBe(now + 20_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.tickIssueMonitors).toHaveBeenCalledTimes(2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    expect(f.nextIssueMonitorAt).toHaveBeenCalledTimes(2);
    expect(f.nextRoutineRunAt).toHaveBeenCalledTimes(2);
    expect(idleWorkSnapshot().active).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.nextIssueMonitorAt).toHaveBeenCalledTimes(2);
    expect(f.nextRoutineRunAt).toHaveBeenCalledTimes(2);
  });

  it.each(["routine", "monitor"] as const)("rescans a %s deadline crossed during an earlier scan", async kind => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tick = vi.fn().mockImplementationOnce(() => held).mockImplementation(async () => {
      f.deadlines[kind] = null;
    });
    const now = Date.UTC(2020, 0, 1);
    const f = fixture({ [kind]: now + 10_000,
      ...(kind === "routine" ? { tickRoutines: tick } : { tickIssueMonitors: tick }) });
    try {
      await (kind === "routine" ? f.workers.monitors.ready : f.workers.routines.ready);
      await vi.advanceTimersByTimeAsync(12_000);
    } finally { release(); await f.ready(); }
    const expected = now + 60_000;
    expect(f.coordinator.nextWakeAt()).toBe(expected);
    await vi.advanceTimersByTimeAsync(expected - Date.now() + 1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it.each(["routine", "monitor"] as const)("retains capped overdue %s work with bounded spacing, then disarms after completion", async kind => {
    const tick = vi.fn(async () => {});
    const now = Date.UTC(2020, 0, 1);
    const f = fixture({ [kind]: now - 10_000, ...(kind === "routine" ? { tickRoutines: tick } : { tickIssueMonitors: tick }) });
    await f.ready();
    expect(f.coordinator.nextWakeAt()).toBe(now + 60_000);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(tick).toHaveBeenCalledTimes(1);
    f.deadlines[kind] = null;
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("rearms an earlier deadline only after the producer transaction settles", async () => {
    const now = Date.UTC(2020, 0, 1);
    const f = fixture({ routine: now + 600_000 });
    await f.ready();
    let commit!: () => void;
    const held = new Promise<void>(resolve => { commit = resolve; });
    const writing = f.owner.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.routineSchedules);
      f.deadlines.routine = now + 10_000;
      await held;
    });
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.tickRoutines).toHaveBeenCalledTimes(1);
      expect(idleWorkSnapshot().active).toBe(1);
    } finally { commit(); await writing; }
    await vi.advanceTimersByTimeAsync(1);
    expect(f.coordinator.nextWakeAt()).toBe(now + 10_000);
    expect(idleWorkSnapshot().active).toBe(0);
    await vi.advanceTimersByTimeAsync(8999);
    expect(f.tickRoutines).toHaveBeenCalledTimes(3);
    expect(f.tickIssueMonitors).toHaveBeenCalledTimes(1);
  });

  it("keeps monitor dispatch responsive while routine work is slow", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ monitor: Date.UTC(2020, 0, 1) + 10_000, tickRoutines: () => held });
    try {
      await f.workers.monitors.ready;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.tickIssueMonitors).toHaveBeenCalledTimes(2);
      expect(f.tickRoutines).toHaveBeenCalledTimes(1);
    } finally { release(); await f.workers.routines.ready; }
  });

  it("does not dispatch during idle drain or standby and cancels deadlines on stop", async () => {
    const f = fixture({ routine: Date.UTC(2020, 0, 1) + 10_000 });
    await f.ready();
    f.canRun(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.tickRoutines).toHaveBeenCalledTimes(1);
    expect(idleWorkSnapshot().active).toBe(0);
    f.canReconcile(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.nextIssueMonitorAt).toHaveBeenCalledTimes(1);
    expect(f.nextRoutineRunAt).toHaveBeenCalledTimes(1);
    await f.coordinator.stop();
    f.canRun(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.tickRoutines).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries failed deadline reads at the fallback interval without a tight loop", async () => {
    const f = fixture();
    await f.ready();
    f.failRead(true);
    f.workers.routines.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.errors).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(f.tickRoutines).toHaveBeenCalledTimes(2);
    f.failRead(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.tickRoutines).toHaveBeenCalledTimes(3);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    expect(idleWorkSnapshot().active).toBe(0);
  });
});
