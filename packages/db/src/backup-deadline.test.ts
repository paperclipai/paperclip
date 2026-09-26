import { describe, expect, it } from "vitest";
import {
  DatabaseBackupTimeoutError,
  MAX_BACKUP_DEADLINE_MS,
  createBackupDeadline,
  normalizeBackupDeadlineMs,
} from "./backup-deadline.js";

/**
 * The production failure was *not* a backup that died — killing a backup
 * already recovers, and release-on-failure already worked. It was a backup that
 * stopped settling: a COPY consumer that stopped draining, with PostgreSQL
 * blocked in `ClientWrite` and `await sql.end()` waiting for that same query.
 * Terminating the database backend cleared the server side and the Node-side
 * wait *still* did not unwind.
 *
 * So every test below models the stuck work with a promise that is never
 * resolved or rejected by anything, and none of them may await it directly.
 */
function neverSettles<T = never>(): Promise<T> {
  return new Promise<T>(() => {});
}

describe("createBackupDeadline", () => {
  it("releases the caller when the guarded operation never settles", async () => {
    const deadline = createBackupDeadline(25);
    try {
      await expect(deadline.guard(neverSettles(), "copying public.heartbeat_run_events")).rejects.toThrow(
        DatabaseBackupTimeoutError,
      );
    } finally {
      deadline.dispose();
    }
  });

  it("reports the phase it was stuck in", async () => {
    const deadline = createBackupDeadline(25);
    try {
      await expect(
        deadline.guard(neverSettles(), "copying public.heartbeat_run_events"),
      ).rejects.toMatchObject({
        phase: "copying public.heartbeat_run_events",
        timeoutMs: 25,
      });
    } finally {
      deadline.dispose();
    }
  });

  it("names the phase entered most recently when guards are nested", async () => {
    const deadline = createBackupDeadline(40);
    try {
      // Mirrors the real nesting order: the whole backup is guarded first, and
      // a per-table COPY guard is entered later, once the dump reaches it.
      const outer = deadline.guard(
        (async () => {
          await Promise.resolve();
          return deadline.guard(neverSettles(), "copying public.agents");
        })(),
        "running the backup",
      );
      await expect(outer).rejects.toMatchObject({ phase: "copying public.agents" });
    } finally {
      deadline.dispose();
    }
  });

  it("runs registered teardown so abandoned resources are not left holding a snapshot", async () => {
    const deadline = createBackupDeadline(25);
    const torn: string[] = [];
    try {
      deadline.onExpire(() => torn.push("copy-connection"));
      deadline.onExpire(() => {
        throw new Error("teardown blew up");
      });
      deadline.onExpire(() => torn.push("pg_dump-child"));

      await expect(deadline.guard(neverSettles(), "running the backup")).rejects.toThrow(
        DatabaseBackupTimeoutError,
      );
      // A throwing teardown must not stop the others, nor the deadline itself.
      expect(torn).toEqual(["copy-connection", "pg_dump-child"]);
      expect(deadline.expired()).toBe(true);
    } finally {
      deadline.dispose();
    }
  });

  it("unregisters teardown that completed before the deadline", async () => {
    const deadline = createBackupDeadline(25);
    const torn: string[] = [];
    try {
      const unregister = deadline.onExpire(() => torn.push("finished-connection"));
      unregister();

      await expect(deadline.guard(neverSettles(), "running the backup")).rejects.toThrow(
        DatabaseBackupTimeoutError,
      );
      expect(torn).toEqual([]);
    } finally {
      deadline.dispose();
    }
  });

  it("passes a value through untouched when the operation beats the deadline", async () => {
    const deadline = createBackupDeadline(5_000);
    try {
      await expect(deadline.guard(Promise.resolve("done"), "running the backup")).resolves.toBe("done");
      expect(deadline.expired()).toBe(false);
    } finally {
      deadline.dispose();
    }
  });

  it("propagates a real failure rather than masking it as a timeout", async () => {
    const deadline = createBackupDeadline(5_000);
    try {
      await expect(
        deadline.guard(Promise.reject(new Error("relation does not exist")), "running the backup"),
      ).rejects.toThrow("relation does not exist");
    } finally {
      deadline.dispose();
    }
  });

  it("rejects immediately once the deadline has already elapsed", async () => {
    const deadline = createBackupDeadline(10);
    try {
      await expect(deadline.guard(neverSettles(), "running the backup")).rejects.toThrow(
        DatabaseBackupTimeoutError,
      );
      // A later phase must not get a fresh grace period from an expired deadline.
      await expect(deadline.guard(Promise.resolve("late"), "pruning")).rejects.toThrow(
        DatabaseBackupTimeoutError,
      );
    } finally {
      deadline.dispose();
    }
  });

  it("does not leave an unhandled rejection when the abandoned operation fails later", async () => {
    const deadline = createBackupDeadline(25);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    let failAbandoned: (error: Error) => void = () => {};
    try {
      const abandoned = new Promise<never>((_resolve, reject) => {
        failAbandoned = reject;
      });
      await expect(deadline.guard(abandoned, "running the backup")).rejects.toThrow(
        DatabaseBackupTimeoutError,
      );

      // The destroyed connection finally rejects the query nobody is watching.
      failAbandoned(new Error("CONNECTION_DESTROYED"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      deadline.dispose();
    }
  });

  it("stops the timer on dispose so a finished backup cannot fire it later", async () => {
    const deadline = createBackupDeadline(20);
    const torn: string[] = [];
    deadline.onExpire(() => torn.push("should-never-run"));

    await expect(deadline.guard(Promise.resolve("done"), "running the backup")).resolves.toBe("done");
    deadline.dispose();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(deadline.expired()).toBe(false);
    expect(torn).toEqual([]);
  });

  /**
   * Node's timer takes a 32-bit signed delay. Anything larger — or non-finite —
   * is clamped to **1ms**, so an operator configuring a very generous deadline
   * would get one that fires almost immediately and fails every backup. That is
   * worse than the unbounded behaviour this module replaces, so the clamp has
   * to happen before the value reaches `setTimeout`.
   */
  describe("deadlines outside the timer's supported range", () => {
    it("caps an over-range deadline instead of letting the timer clamp it to 1ms", async () => {
      const deadline = createBackupDeadline(MAX_BACKUP_DEADLINE_MS + 1);
      try {
        expect(deadline.timeoutMs).toBe(MAX_BACKUP_DEADLINE_MS);
        // The regression: with the raw value the timer fires within a few ms.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(deadline.expired()).toBe(false);
      } finally {
        deadline.dispose();
      }
    });

    it("caps a non-finite deadline rather than failing every backup at once", async () => {
      for (const value of [Number.POSITIVE_INFINITY, Number.NaN]) {
        const deadline = createBackupDeadline(value);
        try {
          expect(deadline.timeoutMs).toBe(MAX_BACKUP_DEADLINE_MS);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(deadline.expired()).toBe(false);
        } finally {
          deadline.dispose();
        }
      }
    });

    it("keeps a sub-millisecond deadline usable", async () => {
      const deadline = createBackupDeadline(0);
      try {
        expect(deadline.timeoutMs).toBe(1);
        await expect(deadline.guard(neverSettles(), "running the backup")).rejects.toThrow(
          DatabaseBackupTimeoutError,
        );
      } finally {
        deadline.dispose();
      }
    });

    it("reports the deadline actually in force, not the one that was asked for", async () => {
      const deadline = createBackupDeadline(25.9);
      try {
        await expect(deadline.guard(neverSettles(), "running the backup")).rejects.toMatchObject({
          timeoutMs: 25,
        });
      } finally {
        deadline.dispose();
      }
    });
  });

  describe("normalizeBackupDeadlineMs", () => {
    it("passes an in-range deadline through untouched", () => {
      expect(normalizeBackupDeadlineMs(60_000)).toBe(60_000);
      expect(normalizeBackupDeadlineMs(MAX_BACKUP_DEADLINE_MS)).toBe(MAX_BACKUP_DEADLINE_MS);
    });

    it("clamps both ends of the supported range", () => {
      expect(normalizeBackupDeadlineMs(0)).toBe(1);
      expect(normalizeBackupDeadlineMs(-5)).toBe(1);
      expect(normalizeBackupDeadlineMs(MAX_BACKUP_DEADLINE_MS + 1)).toBe(MAX_BACKUP_DEADLINE_MS);
      // ~76 years in minutes, the shape of a fat-fingered override.
      expect(normalizeBackupDeadlineMs(40_000_000 * 60_000)).toBe(MAX_BACKUP_DEADLINE_MS);
    });

    it("degrades a non-finite deadline to the maximum, never the minimum", () => {
      // The two directions are not symmetric: too long weakens the bound, too
      // short breaks every backup on the instance.
      expect(normalizeBackupDeadlineMs(Number.POSITIVE_INFINITY)).toBe(MAX_BACKUP_DEADLINE_MS);
      expect(normalizeBackupDeadlineMs(Number.NaN)).toBe(MAX_BACKUP_DEADLINE_MS);
    });
  });
});
