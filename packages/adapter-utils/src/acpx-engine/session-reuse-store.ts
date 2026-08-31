// The generic per-session reuse store.
//
// One `SessionReuseStore<T>` implementation backs both site caches. The host
// site saves a live runtime and session handle. The sandbox site saves the
// staged files. The store is generic in the saved type, so a generic `save`
// cannot read what a site saves. `RunSite.reuseCandidate()` names the concrete
// type per site.
//
// The store operates OVER a caller-provided map, not a private internal map.
// The host lane passes its warm-handle map; the sandbox lane passes its staged-
// runtime map. Both maps persist across runs, so a saved entry stays visible to
// a later run of the same session. Each entry carries its own last-used time and
// its own optional per-entry idle timer, so the store reads and writes those
// through the caller-supplied accessors. This keeps the exact shape both caches
// had before this refactor, so a caller that inspects the map still reads the
// same entries.
//
// The store keeps the exact behavior the two caches had before this refactor:
//
//   * `borrow` reads without removal. It keeps today's visibility for
//     overlapping runs of the same session. It clears the entry's per-entry
//     idle timer, because an in-use entry must not expire under its own timer.
//   * `save` sets the entry in the map. When the store has a per-entry idle
//     timer, `save` arms an unref'd timer that discards the entry at the idle
//     deadline without a run (today's `scheduleIdleHandleCleanup`).
//   * `discard` is an identity-guarded removal that fires the idempotent
//     release once. It acts on the entry that is at the key now, so a re-saved
//     entry is safe and a second discard is a no-op.
//   * `evictIdle` is the run-start sweep (today's `cleanupIdleHandles` and
//     `cleanupIdleStagedRuntimes`). The host lane runs the critical section
//     directly. The sandbox lane runs it under its per-key staging lease and
//     re-checks the idle window inside the lease.

import type { SessionReuseStore } from "./run-contracts.js";

/**
 * The construction options for a reuse store. The public `SessionReuseStore<T>`
 * surface stays generic; these options carry the per-lane behavior the store
 * needs but the interface does not name: the backing map, the clock, the idle
 * bound, how to read an entry's last-used time and per-entry timer, how to
 * release an entry, whether to arm a per-entry timer, and the optional eviction
 * lease.
 */
export interface SessionReuseStoreConfig<T> {
  /**
   * The map the store reads and writes. The caller owns it, so a caller that
   * inspects the map still reads the same entries. The map persists across runs.
   */
  readonly entries: Map<string, T>;
  /** The clock. The store reads it for the idle deadline and the sweep. */
  readonly now: () => number;
  /**
   * The idle bound, in milliseconds. When it is `0` or less, the store arms no
   * per-entry timer and the sweep evicts nothing.
   */
  readonly idleMs: number;
  /** Read an entry's last-used time. The store compares it to the idle bound. */
  readonly lastUsedAt: (entry: T) => number;
  /**
   * Release an entry's resources. The store calls it once per entry on a
   * discard, on a per-entry timer fire, or on an idle sweep. The store guards
   * every release with a map-identity check, so a discarded entry never
   * releases twice.
   */
  readonly release: (entry: T) => void | Promise<void>;
  /**
   * Read an entry's per-entry idle timer, or `undefined` when it holds none.
   * The host lane supplies this; the sandbox lane omits it and arms no timer.
   */
  readonly getTimer?: (entry: T) => ReturnType<typeof setTimeout> | undefined;
  /**
   * Write (or clear with `undefined`) an entry's per-entry idle timer. The host
   * lane supplies this; the sandbox lane omits it.
   */
  readonly setTimer?: (entry: T, timer: ReturnType<typeof setTimeout> | undefined) => void;
  /**
   * Arm a per-entry idle timer on `save`. The host lane sets it true. The
   * sandbox lane leaves it false and relies on the run-start sweep only.
   */
  readonly perEntryTimer?: boolean;
  /**
   * Run each eviction critical section under a per-key lease. The sandbox lane
   * supplies its per-key staging lease so the sweep re-checks the entry inside
   * the lease. The host lane omits it and the sweep runs the critical section
   * directly.
   */
  readonly withEvictLease?: (key: string, critical: () => Promise<void>) => Promise<void>;
}

/**
 * Create a generic per-session reuse store over the caller-provided map. The
 * store holds at most one entry per session key. Each entry carries its saved
 * value, its last-used time, and an optional per-entry idle timer, all read
 * through the config accessors.
 */
export function createSessionReuseStore<T>(
  config: SessionReuseStoreConfig<T>,
): SessionReuseStore<T> {
  const { entries } = config;

  function clearEntryTimer(entry: T): void {
    const timer = config.getTimer?.(entry);
    if (timer === undefined) return;
    clearTimeout(timer);
    config.setTimer?.(entry, undefined);
  }

  // Release an entry once and drop it from the map when it is still the current
  // entry at the key. The map-identity guard makes the release idempotent: the
  // synchronous `delete` runs before the awaited release, so a second release of
  // the same entry finds a different or absent entry at the key and stops.
  async function releaseEntry(key: string, entry: T): Promise<void> {
    clearEntryTimer(entry);
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    await config.release(entry);
  }

  function armTimer(key: string, entry: T): void {
    if (!config.perEntryTimer || config.idleMs <= 0) return;
    clearEntryTimer(entry);
    const delayMs = Math.max(1, config.lastUsedAt(entry) + config.idleMs - config.now());
    const timer = setTimeout(() => {
      void (async () => {
        if (entries.get(key) !== entry) return;
        // A later touch can move `lastUsedAt` forward, so re-check the idle
        // window and re-arm the timer when the entry is still in use.
        if (config.now() - config.lastUsedAt(entry) < config.idleMs) {
          armTimer(key, entry);
          return;
        }
        await releaseEntry(key, entry);
      })();
    }, delayMs);
    timer.unref?.();
    config.setTimer?.(entry, timer);
  }

  return {
    borrow(sessionKey: string): T | undefined {
      const entry = entries.get(sessionKey);
      if (entry === undefined) return undefined;
      // The entry is in use now, so clear its per-entry idle timer. The next
      // `save` re-arms a fresh timer after the run finishes.
      clearEntryTimer(entry);
      return entry;
    },

    save(sessionKey: string, entry: T): void {
      // The caller sets the entry's last-used time before it saves, so `save`
      // sets the entry as-is and arms its timer from that time.
      entries.set(sessionKey, entry);
      armTimer(sessionKey, entry);
    },

    discard(sessionKey: string): Promise<void> {
      const entry = entries.get(sessionKey);
      // `releaseEntry` deletes the key synchronously and then fires the release,
      // so the returned promise lets the caller await the release when it must
      // finish before a downstream resource release.
      if (entry === undefined) return Promise.resolve();
      return releaseEntry(sessionKey, entry);
    },

    async evictIdle(now: number): Promise<void> {
      if (config.idleMs <= 0) return;
      const stale: Array<[string, T]> = [];
      for (const [key, entry] of entries.entries()) {
        if (now - config.lastUsedAt(entry) >= config.idleMs) stale.push([key, entry]);
      }
      for (const [key, entry] of stale) {
        const critical = async (): Promise<void> => {
          if (entries.get(key) !== entry) return;
          // Under a lease the sweep re-checks the idle window, so a run that
          // re-saved the key while the lease was held keeps its entry.
          if (config.withEvictLease && config.now() - config.lastUsedAt(entry) < config.idleMs) {
            return;
          }
          await releaseEntry(key, entry);
        };
        if (config.withEvictLease) {
          await config.withEvictLease(key, critical);
        } else {
          await critical();
        }
      }
    },
  };
}
