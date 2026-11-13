import { createDb } from "@paperclipai/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCustomImageCleanupWork } from "../services/custom-image-cleanup-work.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";

describe("custom-image expiry deadline precision", () => {
  let db: ReturnType<typeof createDb>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    db = createDb("postgres://localhost:1/deadline_precision_test"); });
  afterEach(async () => { await coordinator?.stop(); await db.$client.end({ timeout: 1 }); vi.useRealTimers(); });

  async function start(delay: number, failFirst = false) {
    let due: number | null = Date.now() + delay;
    let expired = 0;
    const errors: unknown[] = [];
    const cleanup = vi.fn(async () => {
      if (due !== null && due <= Date.now()) { expired++; due = null; }
      return { scanned: 0, timedOut: 0, failed: 0 };
    });
    if (failFirst) cleanup.mockRejectedValueOnce(new Error("temporary database failure"));
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true,
      onError: error => errors.push(error) });
    const worker = registerCustomImageCleanupWork(coordinator, {
      cleanupExpiredSetupSessions: cleanup,
      nextSetupCleanupAt: async () => due,
    }, () => true);
    await worker.ready;
    await vi.advanceTimersByTimeAsync(0);
    return { cleanup, errors, worker, expired: () => expired, move: (at: number) => { due = at; worker.wake(); } };
  }

  it("expires at a saved five-second startup deadline and then becomes quiet", async () => {
    const due = Date.now() + 5_000;
    const work = await start(5_000);
    expect(coordinator.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(work.expired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.expired()).toBe(1);
    expect(coordinator.nextWakeAt()).toBeNull();
    const calls = work.cleanup.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(work.cleanup).toHaveBeenCalledTimes(calls);
  });

  it("replaces a future deadline with an earlier wake inside the retry window", async () => {
    const work = await start(60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    const due = Date.now() + 5_000;
    work.move(due);
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(work.expired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.expired()).toBe(1);
  });

  it("retains failure retry spacing even when another wake arrives", async () => {
    const retryAt = Date.now() + 30_000;
    const work = await start(5_000, true);
    expect(work.errors).toHaveLength(1);
    work.worker.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.nextWakeAt()).toBe(retryAt);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(work.cleanup).toHaveBeenCalledTimes(1);
    expect(work.expired()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.expired()).toBe(1);
    expect(work.cleanup).toHaveBeenCalledTimes(2);
    expect(coordinator.nextWakeAt()).toBeNull();
  });
});
