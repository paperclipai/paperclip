/**
 * Single-flight guard for the database backup.
 *
 * A boolean guard released in a `finally` is not enough. A `finally` runs when
 * a promise *settles*, and a backup can stop settling entirely: a COPY whose
 * consumer stopped draining leaves PostgreSQL blocked writing to the client
 * while Node waits for the query to finish before closing the socket. Observed
 * in production for six days — and terminating the database backend outright
 * cleared the server side without releasing the Node-side guard, so "make the
 * database fail fast" does not cover it either.
 *
 * So the guard carries the instant it was taken and is treated as abandoned
 * past a threshold. Leases are token-checked: a stale run that settles late
 * releases nothing, because by then it no longer holds the lease.
 */

/**
 * Largest deadline Node's timer can honour, in seconds. Above this the timer
 * clamps the delay to 1ms, which would fail every backup instantly instead of
 * granting the generous deadline that was asked for.
 *
 * `normalizeBackupDeadlineMs` in `@paperclipai/db` is the authoritative clamp —
 * it is what actually guards the timer, for every caller. This copy of the
 * bound keeps an out-of-range setting from reaching the deadline in the first
 * place, so the operator's configured value and the deadline in force agree.
 * Declared locally rather than imported so this module stays free of a
 * cross-package dependency (`@paperclipai/db` is module-mocked by other server
 * tests, which would leave the constant undefined here).
 */
export const MAX_BACKUP_TIMEOUT_SECONDS = Math.floor(2_147_483_647 / 1000);

/** Shortest deadline an operator may configure. */
export const MIN_BACKUP_TIMEOUT_SECONDS = 60;

/** Shortest staleness threshold, regardless of how short the deadline is. */
export const MIN_BACKUP_STALE_AFTER_MS = 60_000;

/**
 * How many times the backup deadline the staleness threshold must be, at
 * minimum. Taking a lease over is only ever correct when the holder is beyond
 * any doubt abandoned, and a holder inside its own deadline is not.
 */
const STALE_AFTER_DEADLINE_MULTIPLE = 2;

function readPositiveMinutes(
  env: NodeJS.ProcessEnv,
  name: string,
  onInvalid?: (name: string, value: string) => void,
): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return null;
  const minutes = Number(raw);
  // Rejects NaN, ±Infinity and non-positive values alike. An override that
  // cannot be honoured is dropped in favour of the default rather than being
  // propagated into a timer or a comparison.
  if (!Number.isFinite(minutes) || minutes <= 0) {
    onInvalid?.(name, raw);
    return null;
  }
  return minutes;
}

export type DatabaseBackupTimings = {
  /** Deadline for one backup run, already inside the timer's supported range. */
  readonly timeoutSeconds: number;
  /** Guard staleness threshold. Always greater than the deadline. */
  readonly staleAfterMs: number;
};

/**
 * Resolves the backup deadline and the guard's staleness threshold *together*,
 * because the two are not independent.
 *
 * A threshold below the deadline breaks the single-flight guarantee: with a
 * two-hour deadline and a one-hour threshold, the next scheduled run takes the
 * lease over after an hour while the first backup is still inside its own valid
 * deadline — two database- and disk-intensive backups at once, which is the
 * exact overlap this guard exists to prevent. So the threshold has a floor of
 * twice the deadline that an operator may raise but not lower.
 *
 * Both overrides are parsed defensively; see {@link readPositiveMinutes}.
 */
export function resolveDatabaseBackupTimings(options: {
  defaultTimeoutSeconds: number;
  env?: NodeJS.ProcessEnv;
  onInvalid?: (name: string, value: string) => void;
  /**
   * Called when a *valid* staleness override was below the floor and has been
   * raised to it. Distinct from {@link onInvalid}: the operator's value parsed
   * fine, it just cannot be honoured, and silently substituting a different one
   * is how a deliberate setting goes unnoticed.
   */
  onRaisedToFloor?: (
    name: string,
    requestedMinutes: number,
    effectiveMinutes: number,
  ) => void;
}): DatabaseBackupTimings {
  const env = options.env ?? process.env;
  const { onInvalid, onRaisedToFloor } = options;

  const configuredTimeoutMinutes = readPositiveMinutes(
    env,
    "PAPERCLIP_DB_BACKUP_TIMEOUT_MINUTES",
    onInvalid,
  );
  const requestedTimeoutSeconds =
    configuredTimeoutMinutes !== null
      ? Math.round(configuredTimeoutMinutes * 60)
      : options.defaultTimeoutSeconds;
  const timeoutSeconds = Math.min(
    MAX_BACKUP_TIMEOUT_SECONDS,
    Math.max(MIN_BACKUP_TIMEOUT_SECONDS, requestedTimeoutSeconds),
  );

  const configuredStaleAfterMinutes = readPositiveMinutes(
    env,
    "PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES",
    onInvalid,
  );
  const floorMs = Math.max(
    MIN_BACKUP_STALE_AFTER_MS,
    timeoutSeconds * STALE_AFTER_DEADLINE_MULTIPLE * 1000,
  );
  const requestedStaleAfterMs =
    configuredStaleAfterMinutes !== null ? Math.round(configuredStaleAfterMinutes * 60_000) : 0;
  const staleAfterMs = Math.max(floorMs, requestedStaleAfterMs);

  // Only when an override was actually supplied *and* actually raised. An
  // override equal to the floor changed nothing and is not worth a warning.
  if (configuredStaleAfterMinutes !== null && requestedStaleAfterMs < floorMs) {
    onRaisedToFloor?.(
      "PAPERCLIP_DB_BACKUP_STALE_AFTER_MINUTES",
      configuredStaleAfterMinutes,
      staleAfterMs / 60_000,
    );
  }

  return { timeoutSeconds, staleAfterMs };
}

export type DatabaseBackupLease = {
  readonly ok: true;
  /**
   * How long the abandoned predecessor had been holding the guard, or `null`
   * when this lease did not displace anyone.
   */
  readonly tookOverAfterMs: number | null;
  /** Idempotent, and a no-op once another run has taken the lease over. */
  release(): void;
};

export type DatabaseBackupLeaseRejection = {
  readonly ok: false;
  /** How long the current holder has held the guard. */
  readonly heldForMs: number;
};

export type DatabaseBackupGuard = {
  readonly staleAfterMs: number;
  acquire(): DatabaseBackupLease | DatabaseBackupLeaseRejection;
  /** Epoch ms at which the current holder acquired the guard, else `null`. */
  heldSince(): number | null;
};

export function createDatabaseBackupInFlightGuard(options: {
  staleAfterMs: number;
  now?: () => number;
}): DatabaseBackupGuard {
  const now = options.now ?? Date.now;
  const staleAfterMs = Math.max(1, Math.trunc(options.staleAfterMs));
  let holder: { token: symbol; acquiredAtMs: number } | null = null;

  return {
    staleAfterMs,
    heldSince: () => holder?.acquiredAtMs ?? null,
    acquire() {
      const acquiredAtMs = now();
      let tookOverAfterMs: number | null = null;

      if (holder !== null) {
        const heldForMs = acquiredAtMs - holder.acquiredAtMs;
        if (heldForMs < staleAfterMs) {
          return { ok: false, heldForMs };
        }
        tookOverAfterMs = heldForMs;
      }

      const token = Symbol("database-backup-lease");
      holder = { token, acquiredAtMs };

      return {
        ok: true,
        tookOverAfterMs,
        release() {
          // Only the current holder may release. Without this check a run that
          // was declared stale would, on finally settling, clear the lease of
          // the run that replaced it — and two backups could then overlap.
          if (holder?.token === token) holder = null;
        },
      };
    },
  };
}
