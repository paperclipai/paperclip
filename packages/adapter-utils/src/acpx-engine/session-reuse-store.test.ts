// Tests for the generic per-session reuse store (Phase 18).
//
// The store backs both site caches over a caller-provided map. These tests pin
// the four behaviors the two caches had before the refactor: borrow reads
// without removal and clears the per-entry idle timer; discard is
// identity-guarded and releases once; save arms a per-entry idle timer that
// discards without a run; and the run-start sweep runs each eviction under the
// optional per-key lease.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionReuseStore } from "./session-reuse-store.js";

interface Entry {
  readonly id: string;
  lastUsedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

function hostConfig(entries: Map<string, Entry>, released: Entry[], idleMs: number) {
  return {
    entries,
    now: () => Date.now(),
    idleMs,
    lastUsedAt: (entry: Entry) => entry.lastUsedAt,
    getTimer: (entry: Entry) => entry.cleanupTimer,
    setTimer: (entry: Entry, timer: ReturnType<typeof setTimeout> | undefined) => {
      entry.cleanupTimer = timer;
    },
    perEntryTimer: true,
    release: (entry: Entry) => {
      released.push(entry);
    },
  };
}

describe("session reuse store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("test_borrow_reads_without_removal_and_clears_the_per_entry_idle_timer", async () => {
    const entries = new Map<string, Entry>();
    const released: Entry[] = [];
    const store = createSessionReuseStore<Entry>(hostConfig(entries, released, 1000));

    const entry: Entry = { id: "a", lastUsedAt: Date.now() };
    store.save("k", entry);
    expect(entry.cleanupTimer).toBeDefined();

    // A borrow reads the entry and leaves it in the store, so a second borrow
    // still finds it.
    expect(store.borrow("k")).toBe(entry);
    expect(store.borrow("k")).toBe(entry);

    // The borrow cleared the per-entry idle timer, so the entry does not expire
    // while it is in use. Advance well past the idle bound.
    await vi.advanceTimersByTimeAsync(5000);
    expect(released).toEqual([]);
    expect(store.borrow("k")).toBe(entry);
    // The entry stays in the caller's map for a later run to inspect.
    expect(entries.get("k")).toBe(entry);
  });

  it("test_discard_is_identity_guarded_and_fires_release_once", async () => {
    const entries = new Map<string, Entry>();
    const released: Entry[] = [];
    const store = createSessionReuseStore<Entry>({
      entries,
      now: () => Date.now(),
      idleMs: 0,
      lastUsedAt: (entry) => entry.lastUsedAt,
      release: (entry) => {
        released.push(entry);
      },
    });

    const first: Entry = { id: "first", lastUsedAt: Date.now() };
    store.save("k", first);

    // The first discard removes the entry and fires the release once.
    await store.discard("k");
    expect(released).toEqual([first]);
    expect(store.borrow("k")).toBeUndefined();

    // A second discard of the same key finds no entry, so it releases nothing.
    await store.discard("k");
    expect(released).toEqual([first]);

    // A re-saved entry is a new entry. A discard of the key releases the new
    // entry, never the already-released first entry again.
    const second: Entry = { id: "second", lastUsedAt: Date.now() };
    store.save("k", second);
    await store.discard("k");
    expect(released).toEqual([first, second]);
  });

  it("test_save_arms_a_per_entry_idle_timer_that_discards_without_a_run", async () => {
    const entries = new Map<string, Entry>();
    const released: Entry[] = [];
    const store = createSessionReuseStore<Entry>(hostConfig(entries, released, 1000));

    const entry: Entry = { id: "a", lastUsedAt: Date.now() };
    store.save("k", entry);

    // Before the idle deadline the entry is still present and unreleased.
    await vi.advanceTimersByTimeAsync(999);
    expect(released).toEqual([]);

    // At the idle deadline the armed timer discards the entry with no run and
    // no explicit discard call.
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toEqual([entry]);
    expect(store.borrow("k")).toBeUndefined();
    expect(entries.has("k")).toBe(false);
  });

  it("test_evict_idle_sweep_runs_under_per_key_lease", async () => {
    const entries = new Map<string, Entry>();
    const released: Entry[] = [];
    const leaseOrder: string[] = [];
    let now = 0;
    const store = createSessionReuseStore<Entry>({
      entries,
      now: () => now,
      idleMs: 1000,
      lastUsedAt: (entry) => entry.lastUsedAt,
      // The sandbox lane leaves the per-entry timer off and relies on the
      // run-start sweep only.
      release: (entry) => {
        released.push(entry);
      },
      withEvictLease: async (key, critical) => {
        leaseOrder.push(`lease:${key}`);
        await critical();
        leaseOrder.push(`release:${key}`);
      },
    });

    store.save("stale", { id: "stale", lastUsedAt: 0 });
    store.save("fresh", { id: "fresh", lastUsedAt: 0 });

    // Move the clock so only the "stale" entry crosses the idle bound. Touch
    // "fresh" so it stays inside the window.
    now = 1500;
    store.borrow("fresh");
    store.save("fresh", { id: "fresh2", lastUsedAt: now });

    await store.evictIdle(now);

    // Only the stale entry evicts, and its critical section ran inside the
    // per-key lease (lease acquired, critical ran, lease released, in order).
    expect(released.map((entry) => entry.id)).toEqual(["stale"]);
    expect(leaseOrder).toEqual(["lease:stale", "release:stale"]);
    expect(store.borrow("stale")).toBeUndefined();
    expect(store.borrow("fresh")).toEqual({ id: "fresh2", lastUsedAt: 1500 });
  });
});
