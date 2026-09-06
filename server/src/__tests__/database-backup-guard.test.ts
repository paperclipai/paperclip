import { describe, expect, it } from "vitest";
import { createDatabaseBackupInFlightGuard } from "../services/database-backup-guard.js";

const STALE_TIMEOUT_MS = 30 * 60 * 1000;

function createGuard(startMs = 1_000_000) {
  let nowMs = startMs;
  const guard = createDatabaseBackupInFlightGuard({
    staleTimeoutMs: STALE_TIMEOUT_MS,
    now: () => nowMs,
  });
  return {
    guard,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe("createDatabaseBackupInFlightGuard", () => {
  it("blocks a second acquisition while a backup is in flight", () => {
    const { guard, advance } = createGuard();

    const first = guard.tryAcquire();
    expect(first.acquired).toBe(true);

    advance(STALE_TIMEOUT_MS - 1);
    const second = guard.tryAcquire();
    expect(second).toEqual({ acquired: false });
  });

  it("force-resets the in-flight flag after the stale timeout", () => {
    const { guard, advance } = createGuard();

    const first = guard.tryAcquire();
    expect(first.acquired).toBe(true);

    // Simulate a hung backup: the first run never releases.
    advance(STALE_TIMEOUT_MS + 1);
    const second = guard.tryAcquire();
    expect(second.acquired).toBe(true);
    if (second.acquired) {
      expect(second.staleReset).toBe(true);
      expect(second.staleMs).toBeGreaterThan(STALE_TIMEOUT_MS);
    }
  });

  it("does not stale-reset before the timeout elapses", () => {
    const { guard, advance } = createGuard();

    expect(guard.tryAcquire().acquired).toBe(true);
    advance(STALE_TIMEOUT_MS);
    expect(guard.tryAcquire()).toEqual({ acquired: false });
  });

  it("prevents a late-settling hung backup from clearing a newer run's in-flight flag", () => {
    const { guard, advance } = createGuard();

    // Run 1 starts and hangs (never settles within the timeout).
    const hung = guard.tryAcquire();
    expect(hung.acquired).toBe(true);
    if (!hung.acquired) throw new Error("unreachable");

    // Stale guard force-resets; run 2 starts and owns the flag now.
    advance(STALE_TIMEOUT_MS + 1);
    const newer = guard.tryAcquire();
    expect(newer.acquired).toBe(true);
    if (!newer.acquired) throw new Error("unreachable");
    expect(newer.generation).not.toBe(hung.generation);

    // The hung run finally settles. Its release must NOT clear the flag
    // that the newer run now owns.
    guard.release(hung.generation);
    expect(guard.tryAcquire()).toEqual({ acquired: false });

    // When the newer run settles, its own release clears the flag.
    guard.release(newer.generation);
    const third = guard.tryAcquire();
    expect(third.acquired).toBe(true);
    if (third.acquired) {
      expect(third.staleReset).toBe(false);
    }
  });

  it("clears the flag on a normal release so the next run starts immediately", () => {
    const { guard } = createGuard();

    const first = guard.tryAcquire();
    expect(first.acquired).toBe(true);
    if (!first.acquired) throw new Error("unreachable");

    guard.release(first.generation);
    expect(guard.tryAcquire().acquired).toBe(true);
  });
});
