import { describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "@paperclipai/db/work-signals";
import { notifyQueuedRunDispatch } from "../run-dispatch-notifications.js";
import { isIdleTaskDrainActive, readTaskDrain, startTaskDrain, stopTaskDrain } from "../task-admission.js";
import { createDb } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerRunDispatchWork } from "./dispatch-work.js";
import type { UndispatchedQueuedRun } from "../queued-run-dispatch-liveness.js";

describe("queued-run dispatch re-drive", () => {
  it("keeps the companies to re-read when the undispatched-run read fails, and re-drives after the retry", async () => {
    const owner = createDb("postgres://paperclip:unused@127.0.0.1:1/unused", { maxConnections: 1 });
    const stranded: UndispatchedQueuedRun = { runId: "run-1", companyId: "company-1", agentId: "agent-1", issueId: null,
      createdAt: new Date(Date.now() - 10 * 60_000) };
    const reads: Array<string | undefined> = [];
    const list = vi.fn(async (scope?: { companyId: string }) => {
      reads.push(scope?.companyId);
      if (reads.length === 1) throw new Error("transient read failure");
      return [stranded];
    });
    const resumed: Array<string | undefined> = [];
    const errors: unknown[] = [];
    const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: error => errors.push(error) });
    try {
      await registerRunDispatchWork(coordinator, {
        promoteDueScheduledRetries: async () => undefined,
        nextScheduledRetryAt: async () => null,
        schedulingSuppressed: async () => false,
        resumeQueuedRunsAfterDrain: async scope => { resumed.push(scope?.companyId); },
        listUndispatchedQueuedRuns: list,
      }, () => true).ready;
      await expect.poll(() => resumed, { timeout: 45_000, interval: 250 }).toContain("company-1");
      expect(reads.slice(0, 2)).toEqual([undefined, undefined]);
      expect(errors).toEqual([expect.objectContaining({ message: "transient read failure" })]);
    } finally {
      await coordinator.stop();
      await owner.$client.end({ timeout: 1 });
    }
  }, 60_000);
});


describe("queued-run dispatch drain resume", () => {
  function fixture(options: { canDispatch?: () => boolean; due?: number } = {}) {
    const owner = installDatabaseWorkSignals({
      execute: vi.fn(async () => [{ status: "committed" }]),
      transaction: async (callback: (tx: object) => Promise<unknown>) => callback({ execute: async () => [{ xid: "1" }] }),
    });
    const errors: unknown[] = [];
    const canRun = () => (options.canDispatch?.() ?? true) && readTaskDrain(new Date()) === null;
    const coordinator = createDeliveryWorkCoordinator({ owner, canRun, canReconcile: () => true, onError: error => errors.push(error) });
    const resumed: Array<string | undefined> = [];
    let due = options.due ?? null;
    const promote = vi.fn(async () => { if (due !== null && Date.now() >= due) due = null; });
    const work = registerRunDispatchWork(coordinator, {
      promoteDueScheduledRetries: promote,
      nextScheduledRetryAt: async () => due,
      schedulingSuppressed: async () => false,
      resumeQueuedRunsAfterDrain: async scope => { resumed.push(scope?.companyId); },
      listUndispatchedQueuedRuns: async () => [],
    }, canRun);
    const signal = () => owner.transaction(async tx => { await notifyQueuedRunDispatch(tx, { companyId: "company-1" }); });
    return { coordinator, work, signal, resumed, promote, errors };
  }

  it.each(["release", "expiry"] as const)("reconciles the admitted queued-run scope on normal drain %s before the fallback deadline", async mode => {
    vi.useFakeTimers();
    const f = fixture();
    try {
      await f.work.ready;
      expect(f.resumed).toEqual([undefined]);
      startTaskDrain({ purpose: "idle", ttlMs: mode === "expiry" ? 2_000 : null });
      await f.signal(); await vi.advanceTimersByTimeAsync(1_000);
      expect(f.resumed).toEqual([undefined]);
      const fallback = f.coordinator.nextWakeAt();
      expect(fallback).toBeGreaterThan(Date.now());
      expect(fallback).toBeLessThanOrEqual(Date.now() + 30_000);
      if (mode === "release") stopTaskDrain();
      else { await vi.advanceTimersByTimeAsync(1_000); expect(isIdleTaskDrainActive()).toBe(false); }
      await vi.advanceTimersByTimeAsync(0);
      expect(Date.now()).toBeLessThan(fallback!);
      expect(f.resumed).toEqual([undefined, "company-1"]);
      expect(f.coordinator.nextWakeAt()).toBeNull();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(f.resumed).toEqual([undefined, "company-1"]);
      expect(f.errors).toEqual([]);
    } finally { try { await f.coordinator.stop(); } finally { stopTaskDrain(); vi.useRealTimers(); } }
  }, 5_000);

  it("keeps queued reconciliation gated while another drain or dispatch restriction remains", async () => {
    vi.useFakeTimers(); let allowed = true;
    const f = fixture({ canDispatch: () => allowed });
    try {
      await f.work.ready;
      startTaskDrain({ purpose: "idle" }); await f.signal(); await vi.advanceTimersByTimeAsync(1_000);
      startTaskDrain(); await vi.advanceTimersByTimeAsync(0);
      expect(f.resumed).toEqual([undefined]);
      allowed = false; stopTaskDrain(); await vi.advanceTimersByTimeAsync(0);
      expect(f.resumed).toEqual([undefined]);
      allowed = true; startTaskDrain(); stopTaskDrain(); await vi.advanceTimersByTimeAsync(0);
      expect(f.resumed).toEqual([undefined, "company-1"]);
      expect(f.coordinator.nextWakeAt()).toBeNull(); expect(f.errors).toEqual([]);
    } finally { try { await f.coordinator.stop(); } finally { stopTaskDrain(); vi.useRealTimers(); } }
  }, 5_000);

  it("unsubscribes pending drain reconciliation when its normal coordinator stops", async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      await f.work.ready;
      startTaskDrain({ purpose: "idle" }); await f.signal(); await vi.advanceTimersByTimeAsync(1_000);
      await f.coordinator.stop(); stopTaskDrain(); await vi.advanceTimersByTimeAsync(60_000);
      expect(f.resumed).toEqual([undefined]); expect(f.coordinator.nextWakeAt()).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { try { await f.coordinator.stop(); } finally { stopTaskDrain(); vi.useRealTimers(); } }
  }, 5_000);

  it("preserves a genuine scheduled retry deadline and adds no work after idle reconciliation", async () => {
    vi.useFakeTimers(); const due = Date.now() + 10_000; const f = fixture({ due });
    try {
      await f.work.ready; expect(f.promote).toHaveBeenCalledOnce();
      startTaskDrain({ purpose: "idle" }); await f.signal(); await vi.advanceTimersByTimeAsync(1_000);
      stopTaskDrain(); await vi.advanceTimersByTimeAsync(0);
      expect(f.resumed).toEqual([undefined, "company-1"]);
      expect(f.coordinator.nextWakeAt()).toBe(due); expect(f.promote).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(due - Date.now() - 1); expect(f.promote).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1); expect(f.promote).toHaveBeenCalledTimes(2);
      expect(f.coordinator.nextWakeAt()).toBeNull();
      startTaskDrain({ purpose: "idle" }); stopTaskDrain(); await vi.advanceTimersByTimeAsync(90_000);
      expect(f.resumed).toEqual([undefined, "company-1"]); expect(f.promote).toHaveBeenCalledTimes(2);
      expect(f.coordinator.nextWakeAt()).toBeNull(); expect(f.errors).toEqual([]);
    } finally { try { await f.coordinator.stop(); } finally { stopTaskDrain(); vi.useRealTimers(); } }
  }, 5_000);
});
