import { describe, expect, it } from "vitest";
import {
  MAX_BACKUP_TIMEOUT_SECONDS,
  MIN_BACKUP_TIMEOUT_SECONDS,
  createDatabaseBackupInFlightGuard,
  resolveDatabaseBackupTimings,
} from "../database-backup-in-flight-guard.js";

const DEFAULT_TIMEOUT_SECONDS = 60 * 60;

function resolve(env: NodeJS.ProcessEnv) {
  return resolveDatabaseBackupTimings({ env, defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS });
}

/**
 * The regression these cover is specifically *not* "a backup died without
 * releasing its guard" — release-on-failure already worked. It is a backup that
 * never settles at all, so no `finally` anywhere on the stack ever runs. Every
 * test here therefore models the stuck run with a promise that is never
 * resolved, and none of them may await it.
 */
function neverSettles(): Promise<never> {
  return new Promise<never>(() => {});
}

describe("createDatabaseBackupInFlightGuard", () => {
  it("rejects a second run while the first is genuinely still running", () => {
    let nowMs = 1_000;
    const guard = createDatabaseBackupInFlightGuard({ staleAfterMs: 60_000, now: () => nowMs });

    const first = guard.acquire();
    expect(first.ok).toBe(true);

    nowMs += 59_999;
    const second = guard.acquire();
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.heldForMs).toBe(59_999);
  });

  it("releases the guard for the next run without the stuck one ever settling", () => {
    let nowMs = 1_000;
    const guard = createDatabaseBackupInFlightGuard({ staleAfterMs: 60_000, now: () => nowMs });

    const stuck = guard.acquire();
    expect(stuck.ok).toBe(true);
    // The wedged backup. Nothing observes it again; it never settles.
    const wedged = neverSettles();
    expect(wedged).toBeInstanceOf(Promise);

    nowMs += 6 * 24 * 60 * 60 * 1000; // six days, as measured in production
    const next = guard.acquire();
    expect(next.ok).toBe(true);
    if (!next.ok) throw new Error("unreachable");
    expect(next.tookOverAfterMs).toBe(6 * 24 * 60 * 60 * 1000);
  });

  it("does not report a takeover when nothing was displaced", () => {
    let nowMs = 1_000;
    const guard = createDatabaseBackupInFlightGuard({ staleAfterMs: 60_000, now: () => nowMs });

    const first = guard.acquire();
    if (!first.ok) throw new Error("unreachable");
    expect(first.tookOverAfterMs).toBeNull();
    first.release();

    nowMs += 10;
    const second = guard.acquire();
    if (!second.ok) throw new Error("unreachable");
    expect(second.tookOverAfterMs).toBeNull();
    expect(guard.heldSince()).toBe(nowMs);
  });

  it("ignores a stale run that settles after it was taken over", () => {
    let nowMs = 1_000;
    const guard = createDatabaseBackupInFlightGuard({ staleAfterMs: 60_000, now: () => nowMs });

    const stale = guard.acquire();
    if (!stale.ok) throw new Error("unreachable");

    nowMs += 120_000;
    const current = guard.acquire();
    if (!current.ok) throw new Error("unreachable");

    // The abandoned run finally unwinds. It must not hand the guard away from
    // the run that replaced it, or two backups would overlap.
    stale.release();

    nowMs += 1;
    const third = guard.acquire();
    expect(third.ok).toBe(false);
    expect(guard.heldSince()).toBe(1_000 + 120_000);

    current.release();
    expect(guard.heldSince()).toBeNull();
  });

  it("treats release as idempotent", () => {
    const guard = createDatabaseBackupInFlightGuard({ staleAfterMs: 60_000, now: () => 0 });
    const lease = guard.acquire();
    if (!lease.ok) throw new Error("unreachable");

    lease.release();
    lease.release();
    expect(guard.heldSince()).toBeNull();

    const next = guard.acquire();
    expect(next.ok).toBe(true);
    // The double release above must not have freed *this* lease as well.
    expect(guard.heldSince()).toBe(0);
  });
});

describe("resolveDatabaseBackupTimings", () => {
  it("defaults to the backup timeout with twice that as the staleness backstop", () => {
    expect(resolve({})).toEqual({
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      staleAfterMs: DEFAULT_TIMEOUT_SECONDS * 2 * 1000,
    });
  });

  it("honours an in-range timeout override", () => {
    expect(resolve({ PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "90" })).toEqual({
      timeoutSeconds: 90 * 60,
      staleAfterMs: 90 * 60 * 2 * 1000,
    });
  });

  /**
   * The single-flight guarantee is the whole point of the guard. A staleness
   * threshold under the deadline lets the next scheduled run take the lease
   * over while the first backup is still inside its own valid deadline — two
   * database- and disk-intensive backups at once.
   */
  it("never lets the staleness threshold fall below the backup deadline", () => {
    const { timeoutSeconds, staleAfterMs } = resolve({
      PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "120",
      PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "60",
    });
    expect(timeoutSeconds).toBe(120 * 60);
    expect(staleAfterMs).toBeGreaterThan(timeoutSeconds * 1000);
    expect(staleAfterMs).toBe(120 * 60 * 2 * 1000);
  });

  /**
   * Clamping to the floor is correct, but doing it silently is how a
   * deliberate operator setting disappears: they ask for 60 minutes, get 240,
   * and nothing anywhere says so.
   */
  it("reports a staleness override that was raised to the floor", () => {
    const raised: Array<[string, number, number]> = [];
    const { staleAfterMs } = resolveDatabaseBackupTimings({
      env: {
        PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "120",
        PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "60",
      },
      defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      onRaisedToFloor: (name, requested, effective) => raised.push([name, requested, effective]),
    });
    expect(staleAfterMs).toBe(120 * 60 * 2 * 1000);
    // The effective value is reported in the same unit the operator set.
    expect(raised).toEqual([["PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES", 60, 240]]);
  });

  it("stays quiet when the staleness override is honoured, unset, or exactly the floor", () => {
    const raised: string[] = [];
    const cases: NodeJS.ProcessEnv[] = [
      // Honoured: above the floor.
      { PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "60", PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "600" },
      // Unset: the default is not an operator value being overridden.
      { PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "60" },
      // Exactly the floor: nothing was raised, so there is nothing to report.
      { PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "60", PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "120" },
    ];
    for (const env of cases) {
      resolveDatabaseBackupTimings({
        env,
        defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        onRaisedToFloor: (name) => raised.push(name),
      });
    }
    expect(raised).toEqual([]);
  });

  /**
   * An unusable override parses to `null`, which makes the *requested* value
   * 0ms — below the floor like any under-floor setting. It must still be
   * reported as invalid and not as "raised", or one operator mistake produces
   * two contradictory warnings.
   */
  it("reports an unusable staleness override as invalid, never as raised", () => {
    const invalid: string[] = [];
    const raised: string[] = [];
    resolveDatabaseBackupTimings({
      env: {
        PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "60",
        PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "Infinity",
      },
      defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      onInvalid: (name) => invalid.push(name),
      onRaisedToFloor: (name) => raised.push(name),
    });
    expect(invalid).toEqual(["PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES"]);
    expect(raised).toEqual([]);
  });

  it("lets an operator raise the staleness threshold above the floor", () => {
    expect(
      resolve({
        PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "60",
        PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "600",
      }),
    ).toEqual({ timeoutSeconds: 60 * 60, staleAfterMs: 600 * 60_000 });
  });

  it("keeps the one-minute floor when the deadline is at its shortest", () => {
    // 60s deadline -> 120s floor, which already clears the 60_000ms minimum.
    const { timeoutSeconds, staleAfterMs } = resolve({ PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "0.5" });
    expect(timeoutSeconds).toBe(MIN_BACKUP_TIMEOUT_SECONDS);
    expect(staleAfterMs).toBe(120_000);
  });

  /**
   * Node clamps a timer delay above 2^31-1 ms, or a non-finite one, to 1ms.
   * Left unchecked, asking for a very generous deadline would fail every
   * backup almost instantly.
   */
  it("caps a timeout that Node's timer could not honour", () => {
    // ~76 years.
    const { timeoutSeconds } = resolve({ PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "40000000" });
    expect(timeoutSeconds).toBe(MAX_BACKUP_TIMEOUT_SECONDS);
    expect(timeoutSeconds * 1000).toBeLessThanOrEqual(2_147_483_647);
  });

  it("falls back to the default for a non-finite or non-positive override", () => {
    const rejected: string[] = [];
    for (const value of ["Infinity", "-Infinity", "NaN", "not-a-number", "0", "-5", "   "]) {
      const timings = resolveDatabaseBackupTimings({
        env: { PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: value },
        defaultTimeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
        onInvalid: (name) => rejected.push(name),
      });
      expect(timings.timeoutSeconds).toBe(DEFAULT_TIMEOUT_SECONDS);
    }
    // The blank value is a plain "unset", not an operator error worth warning
    // about; the other six are reported.
    expect(rejected).toHaveLength(6);
  });

  it("ignores a non-finite staleness override rather than propagating it", () => {
    const { staleAfterMs } = resolve({
      PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "60",
      PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "Infinity",
    });
    expect(Number.isFinite(staleAfterMs)).toBe(true);
    expect(staleAfterMs).toBe(60 * 60 * 2 * 1000);
  });

  it("produces a guard that actually refuses a takeover inside the deadline", () => {
    const { timeoutSeconds, staleAfterMs } = resolve({
      PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES: "120",
      PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES: "60",
    });
    let nowMs = 1_000;
    const guard = createDatabaseBackupInFlightGuard({ staleAfterMs, now: () => nowMs });
    expect(guard.acquire().ok).toBe(true);

    // One hour in: the old threshold would have handed the lease away here,
    // while the first backup still has an hour of its deadline left.
    nowMs += 60 * 60 * 1000;
    expect(guard.acquire().ok).toBe(false);

    // Still held at the deadline itself.
    nowMs += timeoutSeconds * 1000 - 60 * 60 * 1000;
    expect(guard.acquire().ok).toBe(false);
  });
});
