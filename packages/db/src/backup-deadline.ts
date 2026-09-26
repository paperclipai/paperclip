/**
 * An overall deadline for a database backup.
 *
 * Everything the backup awaits was previously unbounded — the only bound in the
 * whole path was `connect_timeout`, which covers connection setup and nothing
 * else. That is what turns a stalled backup into a *deadlock* rather than a
 * failure: PostgreSQL blocks writing COPY rows to a client that stopped
 * draining, and `finally { await sql.end() }` waits for that very query to
 * finish before closing the socket.
 *
 * The distinguishing property, and the one the tests pin down: a deadline must
 * release its *caller* even when the operation it is waiting on never settles
 * at all. A `finally` fires when a promise settles, so no `finally` — including
 * the caller's in-flight guard — is reachable in that state. Destroying the
 * database connection is not sufficient either; in the production incident the
 * Node-side wait survived the total destruction of the backend it was waiting
 * on.
 */

/**
 * The largest delay Node's timer accepts: it takes a 32-bit signed integer of
 * milliseconds (~24.8 days). A larger delay — or a non-finite one — is clamped
 * to **1ms** with a `TimeoutOverflowWarning`, so an operator asking for a very
 * generous deadline would instead get one that fires almost immediately and
 * fails every backup. That is strictly worse than the unbounded behaviour this
 * module replaces, so the value is normalized before it reaches the timer.
 */
export const MAX_BACKUP_DEADLINE_MS = 2_147_483_647;

/**
 * Clamps a deadline into the range the timer actually supports.
 *
 * A non-finite deadline resolves to the maximum rather than the minimum on
 * purpose. The two failure directions are not symmetric: a deadline that is too
 * long degrades the bound, while one that is too short breaks every backup on
 * the instance. When the configured value cannot be honoured, degrade.
 */
export function normalizeBackupDeadlineMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) return MAX_BACKUP_DEADLINE_MS;
  return Math.min(MAX_BACKUP_DEADLINE_MS, Math.max(1, Math.trunc(timeoutMs)));
}

export class DatabaseBackupTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly phase: string;

  constructor(phase: string, timeoutMs: number) {
    super(`Database backup exceeded its ${Math.round(timeoutMs / 1000)}s deadline while ${phase}`);
    this.name = "DatabaseBackupTimeoutError";
    this.timeoutMs = timeoutMs;
    this.phase = phase;
  }
}

export type BackupDeadline = {
  readonly timeoutMs: number;
  expired(): boolean;
  /**
   * Registers best-effort teardown to run the moment the deadline elapses,
   * returning a function that unregisters it. Teardown is how abandoned
   * resources — a backend still holding the cluster's vacuum horizon, a
   * `pg_dump` child — are released; it is not how the caller is released.
   */
  onExpire(teardown: () => void): () => void;
  /**
   * Rejects with {@link DatabaseBackupTimeoutError} at the deadline.
   * `operation` is abandoned, not cancelled.
   */
  guard<T>(operation: PromiseLike<T>, phase: string): Promise<T>;
  dispose(): void;
};

export function createBackupDeadline(
  timeoutMs: number,
  options: { onTimeout?: (error: DatabaseBackupTimeoutError) => void } = {},
): BackupDeadline {
  const effectiveTimeoutMs = normalizeBackupDeadlineMs(timeoutMs);
  const teardowns = new Set<() => void>();
  const phases: string[] = [];
  let expiredError: DatabaseBackupTimeoutError | null = null;
  let rejectExpiry: ((error: unknown) => void) | null = null;

  const expiry = new Promise<never>((_resolve, reject) => {
    rejectExpiry = reject;
  });
  // The expiry promise is raced against, not always awaited; keep Node from
  // reporting it as an unhandled rejection when nothing is racing it.
  expiry.catch(() => {});

  const timer = setTimeout(() => {
    expiredError = new DatabaseBackupTimeoutError(
      phases[phases.length - 1] ?? "starting up",
      effectiveTimeoutMs,
    );
    for (const teardown of [...teardowns]) {
      try {
        teardown();
      } catch {
        // Teardown is best effort: the deadline must fire regardless.
      }
    }
    teardowns.clear();
    options.onTimeout?.(expiredError);
    rejectExpiry?.(expiredError);
  }, effectiveTimeoutMs);
  // Never hold the process open just to enforce a deadline.
  timer.unref?.();

  return {
    timeoutMs: effectiveTimeoutMs,
    expired: () => expiredError !== null,
    onExpire(teardown) {
      if (expiredError !== null) {
        try {
          teardown();
        } catch {
          // As above.
        }
        return () => {};
      }
      teardowns.add(teardown);
      return () => teardowns.delete(teardown);
    },
    guard<T>(operation: PromiseLike<T>, phase: string): Promise<T> {
      if (expiredError !== null) return Promise.reject(expiredError);
      const pending = Promise.resolve(operation);
      // Once the deadline wins the race nothing observes `pending` again, so
      // attach a sink for the rejection it may still produce later.
      pending.catch(() => {});
      phases.push(phase);
      const leavePhase = () => {
        const index = phases.lastIndexOf(phase);
        if (index >= 0) phases.splice(index, 1);
      };
      return Promise.race([pending, expiry]).then(
        (value) => {
          leavePhase();
          return value;
        },
        (error) => {
          leavePhase();
          throw error;
        },
      );
    },
    dispose() {
      clearTimeout(timer);
      teardowns.clear();
    },
  };
}
