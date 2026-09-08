/**
 * In-flight guard for the server database backup loop.
 *
 * Extracted from startServer() so the stale-reset and generation-token
 * behavior can be unit-tested without booting the whole server.
 *
 * - tryAcquire() returns `{ acquired: false }` while a backup holds the flag,
 *   unless the flag has been held longer than `staleTimeoutMs`, in which case
 *   it is force-reset (stale guard) and the new caller acquires it.
 * - Each acquisition gets a unique generation token. release() only clears the
 *   flag when the caller still owns the current generation, so a hung backup
 *   that settles late cannot clobber the flag after a newer backup started.
 */
export type DatabaseBackupInFlightGuardAcquire =
  | { acquired: true; generation: number; staleReset: boolean; staleMs: number }
  | { acquired: false };

export function createDatabaseBackupInFlightGuard(opts: {
  staleTimeoutMs: number;
  now?: () => number;
}) {
  const staleTimeoutMs = Math.max(0, opts.staleTimeoutMs);
  const now = opts.now ?? Date.now;
  let inFlight = false;
  let startedAtMs = 0;
  let generation = 0;

  return {
    tryAcquire(): DatabaseBackupInFlightGuardAcquire {
      let staleReset = false;
      let staleMs = 0;
      if (inFlight) {
        staleMs = now() - startedAtMs;
        if (staleMs > staleTimeoutMs) {
          inFlight = false;
          staleReset = true;
        } else {
          return { acquired: false };
        }
      }
      const acquiredGeneration = ++generation;
      inFlight = true;
      startedAtMs = now();
      return { acquired: true, generation: acquiredGeneration, staleReset, staleMs };
    },
    release(releaseGeneration: number): void {
      if (releaseGeneration === generation) {
        inFlight = false;
      }
    },
  };
}
