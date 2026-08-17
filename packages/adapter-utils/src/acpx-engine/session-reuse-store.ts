// The generic per-session reuse store.
//
// One `SessionReuseStore<T>` implementation backs both site caches. The host
// site saves a live runtime and session handle. The sandbox site saves the
// staged files. The store is generic in the saved type, so a generic `save`
// cannot read what a site saves. `RunSite.reuseCandidate()` names the concrete
// type per site.
//
// The store keeps the exact behavior the two caches had before this refactor:
//
//   * `borrow` reads without removal. It keeps today's visibility for
//     overlapping runs of the same session. It clears the entry's per-entry
//     idle timer, because an in-use entry must not expire under its own timer.
//   * `save` is a synchronous map set. When the store has a per-entry idle
//     timer, `save` arms an unref'd timer that discards the entry at the idle
//     deadline without a run (today's `scheduleIdleHandleCleanup`).
//   * `discard` is an identity-guarded removal that fires the idempotent
//     release once. It acts on the node that is at the key now, so a re-saved
//     entry is safe and a second discard is a no-op.
//   * `evictIdle` is the run-start sweep (today's `cleanupIdleHandles` and
//     `cleanupIdleStagedRuntimes`). The host lane runs the critical section
//     directly. The sandbox lane runs it under its per-key staging lease.

import type { SessionReuseStore } from "./run-contracts.js";

/**
 * The construction options for a reuse store. The public `SessionReuseStore<T>`
 * surface stays generic; these options carry the per-lane behavior the store
 * needs but the interface does not name: the clock, the idle bound, how to
 * release an entry, whether to arm a per-entry timer, and the optional eviction
 * lease.
 */
export interface SessionReuseStoreConfig<T> {
  /** The clock. The store reads it for the idle deadline and the sweep. */
  readonly now: () => number;
  /**
   * The idle bound, in milliseconds. When it is `0` or less, the store arms no
   * per-entry timer and the sweep evicts nothing.
   */
  readonly idleMs: number;
  /**
   * Release an entry's resources. The store calls it once per node on a
   * discard, on a per-entry timer fire, or on an idle sweep. It must be safe to
   * call more than once for one logical resource, because a shared release
   * closure can ride a reuse chain.
   */
  readonly release: (entry: T) => void | Promise<void>;
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

/** One stored node. The node identity guards the release against a re-save. */
interface StoreNode<T> {
  readonly value: T;
  lastUsedAt: number;
  timer?: ReturnType<typeof setTimeout>;
  released: boolean;
}

/**
 * Create a generic per-session reuse store. The store holds at most one node
 * per session key. Each node carries its saved value, its last-used time, an
 * optional per-entry idle timer, and a one-shot released flag.
 */
export function createSessionReuseStore<T>(
  config: SessionReuseStoreConfig<T>,
): SessionReuseStore<T> {
  const nodes = new Map<string, StoreNode<T>>();

  function clearNodeTimer(node: StoreNode<T>): void {
    if (node.timer === undefined) return;
    clearTimeout(node.timer);
    node.timer = undefined;
  }

  // Release a node once and drop it from the map when it is still the current
  // node at the key. The released flag makes the release idempotent, so the
  // per-entry timer, an explicit discard, and the sweep never release twice.
  async function releaseNode(key: string, node: StoreNode<T>): Promise<void> {
    clearNodeTimer(node);
    if (nodes.get(key) === node) nodes.delete(key);
    if (node.released) return;
    node.released = true;
    await config.release(node.value);
  }

  function armTimer(key: string, node: StoreNode<T>): void {
    if (!config.perEntryTimer || config.idleMs <= 0) return;
    clearNodeTimer(node);
    const delayMs = Math.max(1, node.lastUsedAt + config.idleMs - config.now());
    node.timer = setTimeout(() => {
      void (async () => {
        if (nodes.get(key) !== node) return;
        // A later touch can move `lastUsedAt` forward, so re-check the idle
        // window and re-arm the timer when the node is still in use.
        if (config.now() - node.lastUsedAt < config.idleMs) {
          armTimer(key, node);
          return;
        }
        await releaseNode(key, node);
      })();
    }, delayMs);
    node.timer.unref?.();
  }

  return {
    borrow(sessionKey: string): T | undefined {
      const node = nodes.get(sessionKey);
      if (!node) return undefined;
      // The entry is in use now, so clear its per-entry idle timer. The next
      // `save` re-arms a fresh timer after the run finishes.
      clearNodeTimer(node);
      return node.value;
    },

    save(sessionKey: string, entry: T): void {
      const node: StoreNode<T> = {
        value: entry,
        lastUsedAt: config.now(),
        released: false,
      };
      nodes.set(sessionKey, node);
      armTimer(sessionKey, node);
    },

    discard(sessionKey: string): Promise<void> {
      const node = nodes.get(sessionKey);
      // `releaseNode` deletes the key synchronously and then fires the release,
      // so the returned promise lets the caller await the release when it must
      // finish before a downstream resource release.
      if (!node) return Promise.resolve();
      return releaseNode(sessionKey, node);
    },

    async evictIdle(now: number): Promise<void> {
      if (config.idleMs <= 0) return;
      const stale: Array<[string, StoreNode<T>]> = [];
      for (const [key, node] of nodes.entries()) {
        if (now - node.lastUsedAt >= config.idleMs) stale.push([key, node]);
      }
      for (const [key, node] of stale) {
        // The critical section re-checks the node inside the optional lease, so
        // a run that re-saved the key while the lease was held keeps its entry.
        const critical = async (): Promise<void> => {
          const current = nodes.get(key);
          if (current !== node) return;
          if (config.now() - node.lastUsedAt < config.idleMs) return;
          await releaseNode(key, node);
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
