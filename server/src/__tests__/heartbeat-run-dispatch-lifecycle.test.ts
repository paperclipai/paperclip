import { idleWorkSnapshot } from "../services/task-admission.js";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyRunDispatch, notifyScheduledRetryDispatch } from "../services/run-dispatch-notifications.js";
import { registerRunDispatchWork } from "../services/heartbeat/dispatch-work.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
  vi.useRealTimers();
});
function fixture(input: { due?: number; suppressed?: boolean; draining?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  const dialect = new PgDialect();
  const execute = vi.fn(async (query: any) => {
    if (dialect.sqlToQuery(query).sql.includes("pg_current_xact_id")) return [{ xid: "42" }];
    throw new Error("unexpected database query");
  });
  const db: { execute: typeof execute; transaction: (callback: (tx: any) => Promise<any>) => Promise<any> } = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: any) => Promise<any>): Promise<any> {
    return callback({ execute, transaction: db.transaction });
  } });
  const state = { due: input.due ?? null as number | null, suppressed: input.suppressed ?? false,
    draining: input.draining ?? false, standby: false, fail: false };
  const promote = vi.fn(async () => {
    if (state.fail) throw new Error("database unavailable");
    if (state.due !== null && state.due <= Date.now()) state.due = null;
  });
  const next = vi.fn(async () => state.due);
  const dispatch = vi.fn(async (_scope?: { companyId: string }) => {});
  const coordinator = createDeliveryWorkCoordinator({ owner: db,
    canRun: () => !state.draining && !state.standby, canReconcile: () => !state.standby, onError: vi.fn() });
  const worker = registerRunDispatchWork(coordinator, {
    promoteDueScheduledRetries: promote, nextScheduledRetryAt: next,
    resumeQueuedRunsAfterDrain: dispatch, schedulingSuppressed: async () => state.suppressed,
  }, () => !state.draining && !state.standby);
  cleanup.push(() => coordinator.stop());
  return { db, state, promote, next, dispatch, coordinator, worker,
    notifyRetry: () => db.transaction(tx => notifyScheduledRetryDispatch(tx)),
    notify: (scope?: { companyId: string }) => db.transaction(tx => notifyRunDispatch(tx, scope)),
    settle: () => vi.advanceTimersByTimeAsync(1_000) };
}

describe("run dispatch obligations", () => {
  it.each([false, true])("settles empty/feature-suppressed state and stops all owner work (suppressed=%s)", async suppressed => {
    const f = fixture({ suppressed }); await f.worker.ready;
    const calls = [f.promote.mock.calls.length, f.next.mock.calls.length, f.dispatch.mock.calls.length];
    expect(f.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect([f.promote.mock.calls.length, f.next.mock.calls.length, f.dispatch.mock.calls.length]).toEqual(calls);
    expect(f.db.execute).not.toHaveBeenCalled();
  });
  it("restores an exact deadline and does no earlier recovery work", async () => {
    const f = fixture({ due: 1_010_000 }); await f.worker.ready;
    expect(f.coordinator.nextWakeAt()).toBe(1_010_000);
    await vi.advanceTimersByTimeAsync(9_999); expect(f.promote).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(f.promote).toHaveBeenCalledTimes(2);
    expect(f.state.due).toBeNull(); expect(f.coordinator.nextWakeAt()).toBeNull();
    expect(f.dispatch).toHaveBeenCalledOnce();
  });
  it("rearms earlier work and cancels a future deadline on a committed producer change", async () => {
    const f = fixture({ due: 1_600_000 }); await f.worker.ready;
    f.state.due = 1_005_000; await f.notifyRetry(); await f.settle();
    expect(f.coordinator.nextWakeAt()).toBe(1_005_000);
    f.state.due = null; await f.notifyRetry(); await f.settle();
    expect(f.coordinator.nextWakeAt()).toBeNull();
    const before = f.next.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000); expect(f.next).toHaveBeenCalledTimes(before);
  });
  it("batches repeated tenant writes and passes only their company to queued dispatch", async () => {
    const f = fixture(); await f.worker.ready;
    for (let index = 0; index < 100; index++) {
      const source = { companyId: "company-a", issueId: `issue-${index % 2}`,
        runId: `run-${index}`, agentId: `agent-${index}`, interactionBody: "not a dispatch key" };
      await f.notify(source);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(f.promote).toHaveBeenCalledOnce();
    expect(f.dispatch.mock.calls.length).toBeLessThanOrEqual(2);
    await f.settle();
    expect(f.dispatch).toHaveBeenLastCalledWith({ companyId: "company-a" });
    for (const [scope] of f.dispatch.mock.calls.slice(1)) expect(scope).toEqual({ companyId: "company-a" });
    expect(f.coordinator.nextWakeAt()).toBeNull();
    const count = f.dispatch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000); expect(f.dispatch).toHaveBeenCalledTimes(count);
  });
  it("remembers the first producer arriving during drain without owner SQL", async () => {
    const f = fixture(); await f.worker.ready; f.state.draining = true;
    await f.notifyRetry(); await f.settle(); await vi.advanceTimersByTimeAsync(90_000);
    expect(f.promote).toHaveBeenCalledOnce(); expect(f.next).toHaveBeenCalledOnce();
    expect(idleWorkSnapshot().active).toBe(0);
    f.state.draining = false; await vi.advanceTimersByTimeAsync(30_000);
    expect(f.promote).toHaveBeenCalledTimes(2); expect(f.dispatch).toHaveBeenCalledTimes(2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("releases a failed producer hold during drain and retains recovery for resume", async () => {
    const f = fixture(); await f.worker.ready;
    f.state.fail = true; await f.notifyRetry(); await f.settle();
    expect(f.promote).toHaveBeenCalledTimes(2);
    f.state.draining = true; await vi.advanceTimersByTimeAsync(90_000);
    expect(f.promote).toHaveBeenCalledTimes(2); expect(f.next).toHaveBeenCalledOnce();
    expect(idleWorkSnapshot().active).toBe(0);
    f.state.fail = false; f.state.draining = false; await vi.advanceTimersByTimeAsync(30_000);
    expect(f.promote).toHaveBeenCalledTimes(3); expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("preserves a notification during a nonoverlapping pass", async () => {
    const f = fixture(); await f.worker.ready;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    f.promote.mockImplementationOnce(() => held);
    await f.notifyRetry(); await f.settle();
    await f.notifyRetry(); await f.settle();
    expect(f.promote).toHaveBeenCalledTimes(2);
    release(); await f.settle();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.promote).toHaveBeenCalledTimes(3); expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("does not dispatch on warm standby and cancels deadlines at shutdown", async () => {
    const f = fixture({ due: 1_010_000 }); f.state.standby = true; await f.worker.ready;
    await vi.advanceTimersByTimeAsync(90_000); expect(f.promote).not.toHaveBeenCalled();
    f.state.standby = false; await vi.advanceTimersByTimeAsync(30_000);
    expect(f.promote).toHaveBeenCalledOnce(); expect(f.state.due).toBeNull();
    f.state.due = Date.now() + 60_000; await f.notifyRetry(); await f.settle(); await f.worker.stop();
    await vi.advanceTimersByTimeAsync(90_000); expect(f.promote).toHaveBeenCalledTimes(2);
  });
});
