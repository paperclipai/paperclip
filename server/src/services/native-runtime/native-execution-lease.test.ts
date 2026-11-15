import { afterEach, describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "@paperclipai/db";
import { startNativeSessionExecutionLeaseRenewal } from "./native-execution-lease.js";

const dialect = new PgDialect();

function fixture() {
  // `returning` decides each renewal: the batched UPDATE and the single-run
  // UPDATE both resolve through it.
  const returning = vi.fn(async () => [{ runId: "run" }]);
  const coordinator = vi.fn(async (): Promise<Array<{ attempt: number; leaseOwner: string }>> => []);
  const renewed = vi.fn((_values: unknown) => undefined);
  const update = vi.fn(() => ({ set: (values: unknown) => { renewed(values); return { where: (condition: unknown) => { renewed(condition); return { returning }; } }; } }));
  const select = () => ({ from: () => ({ where: () => ({ limit: coordinator }) }) });
  // The batch locks the coordinator row first; `lock` is what that lock reads.
  const lock = { present: true, live: true };
  const execute = vi.fn(async (query: SQL) => {
    const text = dialect.sqlToQuery(query).sql;    if (text.includes("skip locked")) return lock.present ? [{ run_id: "run", live: lock.live }] : [];
    if (text.includes("set lease_expires_at")) return (await returning()).length ? [{ run_id: "run" }] : [];
    return [];
  });
  const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run({ update, select, execute }));
  const db = { update, transaction };
  return { update, returning, transaction, coordinator, lock, input: { db: db as unknown as Db, runId: "run", companyId: "company", issueId: "issue",
    leaseOwner: "owner", attempt: 1, controller: { bootId: "boot", pid: 1, processStartedAt: new Date() }, remote: true,
    onLost: vi.fn(async () => undefined) } };
}
afterEach(() => vi.useRealTimers());
describe("native execution renewal ownership", () => {
  it("reports only the remaining confirmed ownership budget", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const guard = startNativeSessionExecutionLeaseRenewal({ ...input, confirmedDeadline: performance.now() + 45_000 });
    expect(guard.remainingMs()).toBe(45_000);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(guard.remainingMs()).toBe(5_000);
    complete([{ runId: "run" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(guard.remainingMs()).toBe(40_000);
    await guard.stop();
  });
  it("keeps a successfully renewed lease through repeated slow connection acquisition", async () => {
    vi.useFakeTimers();
    const { input, returning, transaction } = fixture();
    const connected = transaction.getMockImplementation()!;
    transaction.mockImplementation(async run => {
      await new Promise(resolve => setTimeout(resolve, 30_000));
      return connected(run);
    });
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    try {
      // Renewals start at 20s/60s and extend the database lease at 50s/90s.
      // Connection waits must not shorten the successfully extended ownership.
      await vi.advanceTimersByTimeAsync(95_000);
      expect(returning).toHaveBeenCalledTimes(2);
      expect(input.onLost).not.toHaveBeenCalled();
    } finally { await guard.stop().catch(() => undefined); }
    expect(vi.getTimerCount()).toBe(0);
  });
  it("shares one timer across preparation and execution and stops idle SQL after both release", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    const preparation = startNativeSessionExecutionLeaseRenewal(input);
    const execution = startNativeSessionExecutionLeaseRenewal(input);
    expect(returning).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(returning).toHaveBeenCalledTimes(2);
    await preparation.stop();
    await preparation.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(returning).toHaveBeenCalledTimes(3);
    await execution.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(returning).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries cancelled SQL within the original deadline without losing healthy ownership", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    returning.mockRejectedValueOnce(Object.assign(new Error("statement timeout"), { code: "57014" }));
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(returning).toHaveBeenCalledTimes(3);
    expect(input.onLost).not.toHaveBeenCalled();
    await guard.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("renews alone at once after a shared transaction fails for a reason other than a cancelled statement", async () => {
    vi.useFakeTimers();
    const { input, returning, update } = fixture();
    returning.mockRejectedValueOnce(Object.assign(new Error("integer out of range"), { code: "22003" }));
    const guard = startNativeSessionExecutionLeaseRenewal({ ...input, confirmedDeadline: performance.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    // The batch UPDATE failed, then the single path renewed this run alone.
    expect(returning).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(guard.remainingMs()).toBe(60_000);
    expect(input.onLost).not.toHaveBeenCalled();
    await guard.stop();
  });
  it("does not retry every second when the shared and the single renewal both fail (database outage)", async () => {
    vi.useFakeTimers();
    const { input, returning, coordinator } = fixture();
    const outage = Object.assign(new Error("Connection terminated unexpectedly"), { code: "08006" });
    returning.mockRejectedValueOnce(outage).mockRejectedValueOnce(outage);
    coordinator.mockRejectedValueOnce(outage);
    const guard = startNativeSessionExecutionLeaseRenewal({ ...input, confirmedDeadline: performance.now() + 60_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(returning).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(returning).toHaveBeenCalledTimes(2);
    // The next interval goes back to the shared batch.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(returning).toHaveBeenCalledTimes(3);
    expect(guard.remainingMs()).toBe(60_000);
    await guard.stop();
  });
  it("detaches at the deadline while a database response is missing and cannot regain authority from a late response", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(returning).toHaveBeenCalledTimes(1);
    expect(input.onLost).toHaveBeenCalledTimes(1);
    complete([{ runId: "run" }]);
    await expect(guard.stop()).rejects.toThrow("native_session_lease_renewal_deadline");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(returning).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("hands preparation renewal to the same owner's executor at the next attempt", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    const preparation = startNativeSessionExecutionLeaseRenewal(input);
    expect(() => startNativeSessionExecutionLeaseRenewal({ ...input, attempt: 0 })).toThrow("native_session_renewal_binding_changed");
    const executorLost = vi.fn(async () => undefined);
    const execution = startNativeSessionExecutionLeaseRenewal({ ...input, attempt: 2, onLost: executorLost });
    await preparation.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(returning).toHaveBeenCalledTimes(1);
    returning.mockResolvedValueOnce([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(executorLost).toHaveBeenCalledTimes(1);
    expect(input.onLost).not.toHaveBeenCalled();
    await expect(execution.stop()).rejects.toThrow("native_session_lease_lost");
  });
  it("gives the executor that takes over at the next attempt its own later deadline", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    const preparation = startNativeSessionExecutionLeaseRenewal({ ...input, confirmedDeadline: performance.now() + 25_000 });
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    await vi.advanceTimersByTimeAsync(20_000);
    const executorLost = vi.fn(async () => undefined);
    const execution = startNativeSessionExecutionLeaseRenewal({ ...input, attempt: 2, onLost: executorLost,
      confirmedDeadline: performance.now() + 60_000 });
    expect(execution.remainingMs()).toBe(60_000);
    const released = preparation.stop().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executorLost).not.toHaveBeenCalled();
    complete([{ runId: "run" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(execution.remainingMs()).toBeGreaterThanOrEqual(30_000);
    await released;
    await execution.stop();
  });
  it("reacquires a lapsed local lease with the generation of the attempt that took over", async () => {
    vi.useFakeTimers();
    const { input, update, returning, lock } = fixture();
    // The local lease lapsed (host sleep): only the single-run path may take it back.
    lock.live = false;
    const conditions: unknown[] = [];
    update.mockImplementation(() => ({ set: () => ({ where: (condition: unknown) => { conditions.push(condition); return { returning }; } }) }));
    const local = { ...input, remote: false, controllerGeneration: 3 };
    const preparation = startNativeSessionExecutionLeaseRenewal(local);
    const execution = startNativeSessionExecutionLeaseRenewal({ ...local, attempt: 2, controllerGeneration: 4 });
    await preparation.stop();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const values = (root: unknown) => {
      const found = new Set<unknown>(), seen = new WeakSet<object>();
      const walk = (node: unknown) => {
        if (node === null || typeof node !== "object") { found.add(node); return; }
        if (seen.has(node)) return; seen.add(node);
        for (const child of Object.values(node)) walk(child);
      };
      walk(root);
      return found;
    };
    expect(conditions.length).toBeGreaterThan(0);
    expect(values(conditions.at(-1)).has(4)).toBe(true);
    expect(values(conditions.at(-1)).has(3)).toBe(false);
    await execution.stop();
  });
  it("does not count a renewal that failed because the owner's executor advanced the attempt", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const preparation = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(returning).toHaveBeenCalledTimes(1);
    const execution = startNativeSessionExecutionLeaseRenewal({ ...input, attempt: 2 });
    complete([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(returning).toHaveBeenCalledTimes(2);
    expect(input.onLost).not.toHaveBeenCalled();
    await preparation.stop();
    await execution.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps renewing when the coordinator shows its own owner already claimed the next attempt", async () => {
    vi.useFakeTimers();
    const { input, returning, coordinator } = fixture();
    coordinator.mockResolvedValue([{ attempt: 2, leaseOwner: "owner" }]);
    returning.mockResolvedValueOnce([]);
    const preparation = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(coordinator).toHaveBeenCalledTimes(1);
    expect(input.onLost).not.toHaveBeenCalled();
    const execution = startNativeSessionExecutionLeaseRenewal({ ...input, attempt: 2 });
    await preparation.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(returning).toHaveBeenCalledTimes(2);
    expect(input.onLost).not.toHaveBeenCalled();
    await execution.stop();
  });
  it("does not queue SQL behind a slow renewal and fences a lost owner", async () => {
    vi.useFakeTimers();
    const { input, returning } = fixture();
    let complete!: (value: { runId: string }[]) => void;
    returning.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const guard = startNativeSessionExecutionLeaseRenewal(input);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(returning).toHaveBeenCalledTimes(1);
    complete([]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(returning).toHaveBeenCalledTimes(1);
    expect(input.onLost).toHaveBeenCalledTimes(1);
    expect(() => startNativeSessionExecutionLeaseRenewal(input)).toThrow("native_session_lease_lost");
    await expect(guard.stop()).rejects.toThrow("native_session_lease_lost");
    expect(vi.getTimerCount()).toBe(0);
  });
});
