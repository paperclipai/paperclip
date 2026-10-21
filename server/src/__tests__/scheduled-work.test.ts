import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerScheduledWork } from "../services/scheduled-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  vi.useRealTimers();
});

function fixture(input: { routine?: number | null; monitor?: number | null; tickTimers?: () => Promise<void>; tickRoutines?: () => Promise<void> } = {}) {
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
    const at = deadlines[text.includes("routine_triggers") ? "routine" : "monitor"];
    return [{ next_at: at !== null && at > Date.parse(String(compiled.params[0])) ? new Date(at) : null }];
  });
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: any) => Promise<any>) {
    return callback({ execute, transaction: owner.transaction });
  } });
  const errors = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => canRun, canReconcile: () => canReconcile, onError: errors });
  coordinators.push(coordinator);
  const tickTimers = vi.fn(input.tickTimers ?? (async () => {}));
  const tickRoutines = vi.fn(input.tickRoutines ?? (async () => {}));
  const workers = registerScheduledWork(coordinator, owner as unknown as Db,
    { retryMs: 60_000, tickTimers, tickRoutines });
  return { coordinator, workers, owner, deadlines, execute, tickTimers, tickRoutines, errors,
    ready: () => Promise.all([workers.routines.ready, workers.timers.ready]),
    canRun: (value: boolean) => { canRun = value; }, canReconcile: (value: boolean) => { canReconcile = value; }, failRead: (value: boolean) => { failRead = value; } };
}

describe("scheduled routine and monitor deadlines", () => {
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
    expect(f.tickTimers).toHaveBeenCalledTimes(1);
    expect(f.coordinator.nextWakeAt()).toBe(now + 20_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.tickTimers).toHaveBeenCalledTimes(2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    expect(f.execute).toHaveBeenCalledTimes(4);
    expect(idleWorkSnapshot().active).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.execute).toHaveBeenCalledTimes(4);
  });

  it.each(["routine", "monitor"] as const)("rescans a %s deadline crossed during an earlier scan", async kind => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const tick = vi.fn().mockImplementationOnce(() => held).mockResolvedValue(undefined);
    const now = Date.UTC(2020, 0, 1);
    const f = fixture({ [kind]: now + 10_000,
      ...(kind === "routine" ? { tickRoutines: tick } : { tickTimers: tick }) });
    try {
      await (kind === "routine" ? f.workers.timers.ready : f.workers.routines.ready);
      await vi.advanceTimersByTimeAsync(12_000);
    } finally { release(); await f.ready(); }
    expect(f.coordinator.nextWakeAt()).toBe(Date.now());
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("leaves work already overdue at scan start for bounded heartbeat recovery", async () => {
    const f = fixture({ routine: Date.UTC(2020, 0, 1) - 10_000 });
    await f.ready();
    expect(f.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.tickRoutines).toHaveBeenCalledTimes(1);
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
    expect(f.tickTimers).toHaveBeenCalledTimes(1);
  });

  it("keeps monitor dispatch responsive while routine work is slow", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const f = fixture({ monitor: Date.UTC(2020, 0, 1) + 10_000, tickRoutines: () => held });
    try {
      await f.workers.timers.ready;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.tickTimers).toHaveBeenCalledTimes(2);
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
    expect(f.execute).toHaveBeenCalledTimes(2);
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
