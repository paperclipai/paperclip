import { afterEach, expect, it, vi } from "vitest";
import { startNativeMaintenanceLeaseRenewal } from "./native-maintenance-lease.js";
afterEach(() => vi.useRealTimers());

it("renews for arbitrarily many intervals without queuing work during a slow database write", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const renew = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const lease = startNativeMaintenanceLeaseRenewal(renew);
  try {
    await vi.advanceTimersByTimeAsync(15_000); expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000); expect(renew).toHaveBeenCalledTimes(1);
    release(); await lease.assert();
    await vi.advanceTimersByTimeAsync(15_000); expect(renew).toHaveBeenCalledTimes(2);
    release(); await lease.stop();
    await vi.advanceTimersByTimeAsync(60_000); expect(renew).toHaveBeenCalledTimes(2);
  } finally { release?.(); await lease.stop(); }
});

it("retains renewal failure so no later authority check can ignore lease loss", async () => {
  vi.useFakeTimers();
  const renew = vi.fn(async () => { throw new Error("ownership lost"); });
  const lease = startNativeMaintenanceLeaseRenewal(renew);
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(lease.assert()).rejects.toThrow("ownership lost");
    await vi.advanceTimersByTimeAsync(60_000); expect(renew).toHaveBeenCalledTimes(1);
    await expect(lease.assert()).rejects.toThrow("ownership lost");
  } finally { await lease.stop(); }
});

it("cancels attached staging work when renewal fails and preserves the original reason", async () => {
  vi.useFakeTimers();
  const reason = new Error("migration owner changed");
  const lease = startNativeMaintenanceLeaseRenewal(async () => { throw reason; });
  const abort = vi.fn();
  lease.signal.addEventListener("abort", abort);
  try {
    expect(lease.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.signal.reason).toBe(reason);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(() => lease.assertKnown()).toThrow(reason);
  } finally { await lease.stop(); }
});

it("bounds a lost database response and never revives the owner when it arrives late", async () => {
  vi.useFakeTimers();
  let complete!: () => void;
  const renew = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const lease = startNativeMaintenanceLeaseRenewal(renew, 15_000, { renewalTimeoutMs: 30_000 });
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    // A transaction must be able to check the sticky failure without awaiting
    // a background query blocked on a row lock owned by that transaction.
    lease.assertKnown();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(lease.assert()).rejects.toThrow("native_maintenance_lease_renewal_timeout");
    expect(lease.signal.aborted).toBe(true);
    complete();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(() => lease.assertKnown()).toThrow("native_maintenance_lease_renewal_timeout");
  } finally { complete?.(); await lease.stop(); }
});
