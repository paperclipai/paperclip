import { createDb } from "@paperclipai/db";
import { reconcileDatabaseWorkNotifications } from "@paperclipai/db/work-signals";
import { describe, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { isIdleTaskDrainActive, readTaskDrain, startTaskDrain, stopTaskDrain } from "../../task-admission.js";
import { registerDiscordCommandWork } from "./command-work.js";
import type { CommandRegistrationDeadline } from "./command-schedule.js";

async function fixture(options: { drain?: boolean; ttlMs?: number; empty?: boolean; failChecks?: number } = {}) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-11-14T00:00:00Z"));
  if (options.drain) startTaskDrain({ purpose: "idle", ttlMs: options.ttlMs });
  const owner = createDb("postgres://paperclip:unused@127.0.0.1:1/unused", { maxConnections: 1 });
  let allowed = true;
  const canRun = vi.fn(() => allowed && !isIdleTaskDrainActive());
  const entry: CommandRegistrationDeadline = { id: "endpoint-1", companyId: "company-1", connectionId: "connection-1", dueAt: Date.now() };
  let entries: CommandRegistrationDeadline[] = options.empty ? [] : [entry];
  const load = vi.fn(async () => entries);
  let remainingFailures = options.failChecks ?? 0;
  const check = vi.fn(async () => {
    if (remainingFailures-- > 0) throw new Error("Provider attempt failed");
    entries = [];
    return null;
  });
  const errors: unknown[] = [];
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun, canReconcile: () => true, onError: error => errors.push(error) });
  const worker = registerDiscordCommandWork(coordinator, { load, check }, canRun);
  await worker.ready;
  return { owner, coordinator, worker, canRun, load, check, errors, entry,
    allow(value: boolean) { allowed = value; },
    owe() { entries = [entry]; },
    async close() {
      try { await coordinator.stop(); }
      finally {
        try { await owner.$client.end({ timeout: 1 }); }
        finally { stopTaskDrain(); vi.useRealTimers(); }
      }
    },
  };
}

describe("Discord command registration admission drain", () => {
  it("reconciles a retained due registration on release before the coordinator fallback", async () => {
    const f = await fixture({ drain: true });
    try {
      expect(f.load).not.toHaveBeenCalled();
      const fallback = f.coordinator.nextWakeAt();
      expect(fallback).toBeGreaterThan(Date.now());
      expect(fallback).toBeLessThanOrEqual(Date.now() + 30_000);
      await vi.advanceTimersByTimeAsync(1_000);
      stopTaskDrain();
      await vi.advanceTimersByTimeAsync(10);
      expect(Date.now()).toBeLessThan(fallback!);
      expect(f.check.mock.calls).toEqual([["endpoint-1", expect.any(AbortSignal)]]);
      expect(f.load).toHaveBeenCalledOnce();
      expect(f.coordinator.nextWakeAt()).toBeNull();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.check).toHaveBeenCalledOnce();
      expect(f.load).toHaveBeenCalledOnce();
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("reconciles a retained due registration on observed expiry before the coordinator fallback", async () => {
    const f = await fixture({ drain: true, ttlMs: 1_000 });
    try {
      const fallback = f.coordinator.nextWakeAt();
      expect(fallback).toBeGreaterThan(Date.now());
      expect(fallback).toBeLessThanOrEqual(Date.now() + 30_000);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(readTaskDrain(new Date())).toBeNull();
      await vi.advanceTimersByTimeAsync(10);
      expect(Date.now()).toBeLessThan(fallback!);
      expect(f.check.mock.calls).toEqual([["endpoint-1", expect.any(AbortSignal)]]);
      expect(f.load).toHaveBeenCalledOnce();
      expect(f.coordinator.nextWakeAt()).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("does not refresh a due registration while another admission gate remains closed", async () => {
    const f = await fixture({ drain: true });
    try {
      f.allow(false);
      stopTaskDrain();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(f.load).not.toHaveBeenCalled();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("keeps a retained hint behind its future earliest deadline on release", async () => {
    const f = await fixture({ empty: true });
    try {
      expect(f.load).toHaveBeenCalledOnce();
      f.owe();
      startTaskDrain({ purpose: "idle" });
      reconcileDatabaseWorkNotifications(f.owner);
      await vi.advanceTimersByTimeAsync(1_000);
      const earliest = f.coordinator.nextWakeAt();
      expect(earliest).toBeGreaterThan(Date.now());
      stopTaskDrain();
      await vi.advanceTimersByTimeAsync(10);
      expect(f.load).toHaveBeenCalledOnce();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.coordinator.nextWakeAt()).toBe(earliest);
      await vi.advanceTimersByTimeAsync(earliest! - Date.now());
      expect(f.check).toHaveBeenCalledOnce();
      expect(f.coordinator.nextWakeAt()).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it("preserves per-item exponential failure backoff across release", async () => {
    const f = await fixture({ failChecks: 2 });
    try {
      expect(f.check).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.check).toHaveBeenCalledTimes(2);
      const retryAt = Date.now() + 60_000;
      expect(f.coordinator.nextWakeAt()).toBeGreaterThan(Date.now());
      startTaskDrain({ purpose: "idle" });
      await vi.advanceTimersByTimeAsync(1_000);
      stopTaskDrain();
      await vi.advanceTimersByTimeAsync(10);
      expect(f.check).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
      expect(f.check).toHaveBeenCalledTimes(2);
      expect(f.coordinator.nextWakeAt()).toBe(retryAt);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.check).toHaveBeenCalledTimes(3);
      expect(f.errors).toHaveLength(2);
      expect(f.coordinator.nextWakeAt()).toBeNull();
    } finally { await f.close(); }
  });

  it("does not scan an empty owner or retain recurring work after release and expiry", async () => {
    const f = await fixture({ empty: true });
    try {
      expect(f.coordinator.nextWakeAt()).toBeNull();
      startTaskDrain({ purpose: "idle" });
      stopTaskDrain();
      startTaskDrain({ purpose: "idle", ttlMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(readTaskDrain(new Date())).toBeNull();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.load).toHaveBeenCalledOnce();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.coordinator.nextWakeAt()).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });

  it.each(["worker", "coordinator"] as const)("unsubscribes release and expiry refresh after %s stop", async mode => {
    const f = await fixture({ drain: true });
    try {
      if (mode === "worker") await f.worker.stop();
      else await f.coordinator.stop();
      f.canRun.mockClear();
      stopTaskDrain();
      startTaskDrain({ purpose: "idle", ttlMs: 1_000 });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(readTaskDrain(new Date())).toBeNull();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.canRun).not.toHaveBeenCalled();
      expect(f.load).not.toHaveBeenCalled();
      expect(f.check).not.toHaveBeenCalled();
      expect(f.coordinator.nextWakeAt()).toBeNull();
      expect(f.errors).toEqual([]);
    } finally { await f.close(); }
  });
});
