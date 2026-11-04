import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueRecoveryActions, issueWatchdogs } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyIssueRecovery } from "../services/issue-recovery-notifications.js";
import { registerIssueRecoveryWork } from "../services/recovery/work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const stops: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(1_000_000);
  const dialect = new PgDialect();
  const rows = { issues: [] as Array<{ id: string; companyId: string }>, watchdogs: [] as Array<{ id: string; companyId: string }>, blockers: [] as Array<{ id: string; companyId: string }>, actions: [] as Array<{ id: string; companyId: string }> };
  const execute = vi.fn(async (query: any) => {
    if (dialect.sqlToQuery(query).sql.includes("pg_current_xact_id")) return [{ xid: "42" }];
    throw new Error("unexpected SQL");
  });
  const load = vi.fn((table: unknown, distinct = false) => distinct
    ? table === issueRecoveryActions ? rows.actions : rows.blockers
    : table === issueWatchdogs ? rows.watchdogs : rows.issues);
  const query = (distinct = false) => ({ from: (table: unknown) => ({ where: () => ({ orderBy: () => ({ limit: async () => load(table, distinct) }) }) }) });
  const db: any = installDatabaseWorkSignals({ execute,
    select: () => query(), selectDistinct: () => query(true),
    transaction: async (callback: (tx: any) => Promise<unknown>) => callback({ execute, select: db.select, selectDistinct: db.selectDistinct, transaction: db.transaction }),
  });
  const state = { draining: false, standby: false, suppressed: false, deadline: null as number | null, fail: false, incomplete: false };
  const check = vi.fn(async (scope: { onDeferredDeadline(at: number): void }) => {
    if (state.fail) throw new Error("database unavailable");
    if (state.deadline !== null && state.deadline > Date.now()) scope.onDeferredDeadline(state.deadline);
  });
  const orphanBlockers = vi.fn(async () => {}), recoveryActions = vi.fn(async () => {});
  const suppression = vi.fn(async () => state.suppressed);
  const owner = { orphanBlockers, recoveryActions, stranded: check, dependencies: async (scope: any) => { await check(scope); return { enqueueFailed: 0 }; },
    locks: check, watchdogs: async (scope: any) => { await check(scope); return { incomplete: state.incomplete ? 1 : 0 }; },
    schedulingSuppressed: suppression };
  const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => !state.standby,
    canReconcile: () => !state.standby, onError: vi.fn() });
  const worker = registerIssueRecoveryWork(db, coordinator, owner, () => !state.draining && !state.standby);
  stops.push(() => coordinator.stop());
  return { db, rows, state, check, load, coordinator, worker, orphanBlockers, recoveryActions, suppression,
    notify: () => db.transaction((tx: any) => notifyIssueRecovery(tx, { companyId: "selected" })),
    settle: () => vi.advanceTimersByTimeAsync(1_000) };
}
describe("issue recovery obligation lifecycle", () => {
  it("has no timer, SQL, or owner probe after empty reconstruction", async () => {
    const f = fixture(); await f.worker.ready;
    expect(f.coordinator.nextWakeAt()).toBeNull(); const loaded = f.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(f.load).toHaveBeenCalledTimes(loaded); expect(f.check).not.toHaveBeenCalled();
  });
  it("reads scheduling suppression once per pass instead of once per issue", async () => {
    const f = fixture();
    f.rows.issues.push(...Array.from({ length: 25 }, (_, index) => ({ id: `issue-${index}`, companyId: "selected" })));
    await f.worker.ready;
    expect(f.check).toHaveBeenCalledTimes(75);
    expect(f.suppression).toHaveBeenCalledTimes(6);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("backs off a failed suppression read without probing an empty or failed owner repeatedly", async () => {
    const f = fixture(); f.suppression.mockRejectedValueOnce(new Error("settings unavailable"));
    await f.worker.ready; const reads = f.suppression.mock.calls.length;
    expect(f.coordinator.nextWakeAt()).toBe(1_030_000);
    await vi.advanceTimersByTimeAsync(29_999); expect(f.suppression).toHaveBeenCalledTimes(reads);
    await vi.advanceTimersByTimeAsync(1); expect(f.suppression).toHaveBeenCalledTimes(reads + 1);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("normalizes a wide scope with cyclic SQL objects before publishing work hints", async () => {
    const f = fixture(); await f.worker.ready;
    const wide = { companyId: "selected", endpointId: issueRecoveryActions.id, table: issueRecoveryActions };
    await f.db.transaction((tx: object) => notifyIssueRecovery(tx, wide)); await f.settle();
    expect(f.coordinator.nextWakeAt()).toBeNull();
    const loads = f.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * 60_000); expect(f.load).toHaveBeenCalledTimes(loads);
  });
  it("runs orphan blocker and action duties without assignment entries", async () => {
    const f = fixture(); f.rows.blockers.push({ id: "selected", companyId: "selected" });
    f.rows.actions.push({ id: "selected", companyId: "selected" }); await f.worker.ready;
    expect(f.check).not.toHaveBeenCalled();
    expect(f.orphanBlockers).toHaveBeenCalledExactlyOnceWith({ companyId: "selected" });
    expect(f.recoveryActions).toHaveBeenCalledExactlyOnceWith({ companyId: "selected" });
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("coalesces repeated company reconstruction without delaying an existing lease deadline", async () => {
    const f = fixture(); f.rows.issues.push({ id: "issue", companyId: "selected" });
    f.state.deadline = 1_015_000; await f.worker.ready;
    await f.notify(); await f.settle(); const loaded = f.load.mock.calls.length, checked = f.check.mock.calls.length;
    for (let index = 0; index < 100; index++) { await f.notify(); await vi.advanceTimersByTimeAsync(10); }
    expect(f.load).toHaveBeenCalledTimes(loaded); expect(f.check).toHaveBeenCalledTimes(checked);
    await vi.advanceTimersByTimeAsync(13_000);
    expect(f.state.deadline).toBe(1_015_000);
    expect(f.coordinator.nextWakeAt()).toBe(1_031_000);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(f.load.mock.calls.length).toBeGreaterThan(loaded);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("retains exact grace and lease deadlines without early owner probes", async () => {
    const f = fixture(); f.rows.issues.push({ id: "issue", companyId: "selected" });
    f.rows.watchdogs.push({ id: "watchdog", companyId: "selected" }); f.state.deadline = 1_015_000;
    await f.worker.ready; expect(f.coordinator.nextWakeAt()).toBe(1_015_000);
    const checked = f.check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(14_999); expect(f.check).toHaveBeenCalledTimes(checked);
    await vi.advanceTimersByTimeAsync(1); expect(f.check.mock.calls.length).toBe(checked * 2);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("releases settled producer holds during domain drain while coordinator remains open", async () => {
    const f = fixture(); await f.worker.ready; f.state.draining = true;
    f.rows.issues.push({ id: "issue", companyId: "selected" });
    await f.notify(); await f.settle(); const loaded = f.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.load).toHaveBeenCalledTimes(loaded); expect(f.check).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    f.state.draining = false; f.worker.wake(); await f.settle();
    expect(f.check).toHaveBeenCalled(); expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("retries concrete failed entries and then disarms without reloading the company", async () => {
    const f = fixture(); f.rows.issues.push({ id: "issue", companyId: "selected" }); f.state.fail = true;
    await f.worker.ready; const loaded = f.load.mock.calls.length;
    expect(f.coordinator.nextWakeAt()).toBe(1_030_000);
    await vi.advanceTimersByTimeAsync(29_999); const checked = f.check.mock.calls.length;
    f.state.fail = false; await vi.advanceTimersByTimeAsync(1);
    expect(f.check.mock.calls.length).toBe(checked * 2); expect(f.load).toHaveBeenCalledTimes(loaded);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("keeps an incomplete watchdog subtree as concrete retry debt", async () => {
    const f = fixture(); f.rows.watchdogs.push({ id: "watchdog", companyId: "selected" }); f.state.incomplete = true;
    await f.worker.ready; expect(f.coordinator.nextWakeAt()).toBe(1_030_000);
    const loaded = f.load.mock.calls.length; f.state.incomplete = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.check).toHaveBeenCalledTimes(2); expect(f.load).toHaveBeenCalledTimes(loaded);
    expect(f.coordinator.nextWakeAt()).toBeNull();
  });
  it("keeps a concurrent producer dirty until the in-flight owner has completed", async () => {
    const f = fixture(); f.rows.issues.push({ id: "issue", companyId: "selected" }); await f.worker.ready;
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    f.check.mockImplementationOnce(() => held);
    await f.notify(); await f.settle(); await f.notify(); release(); await f.settle(); await vi.advanceTimersByTimeAsync(30_000);
    expect(f.coordinator.nextWakeAt()).toBeNull();
    expect(f.check.mock.calls.length).toBeGreaterThan(3);
  });
  it("retains startup work on standby and cancels future deadlines on shutdown", async () => {
    const f = fixture(); f.state.standby = true; f.rows.watchdogs.push({ id: "watchdog", companyId: "selected" });
    await f.worker.ready; await vi.advanceTimersByTimeAsync(90_000); expect(f.load).not.toHaveBeenCalled();
    f.state.standby = false; f.state.deadline = Date.now() + 60_000; f.worker.wake(); await f.settle();
    expect(f.check).toHaveBeenCalledOnce(); await f.worker.stop();
    await vi.advanceTimersByTimeAsync(120_000); expect(f.check).toHaveBeenCalledOnce();
  });
});
