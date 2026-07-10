import { describe, expect, it, vi } from "vitest";
import {
  LeaderElection,
  createLeaseStore,
  createStorageRelayShared,
  type LeaseStore,
  type SharedMessage,
} from "./cross-tab-poll";

class MemoryLeaseStore implements LeaseStore {
  record: ReturnType<LeaseStore["read"]> = null;

  read() {
    return this.record;
  }

  write(record: NonNullable<ReturnType<LeaseStore["read"]>>) {
    this.record = { ...record };
  }

  clear() {
    this.record = null;
  }
}

describe("LeaderElection", () => {
  it("elects one visible leader and keeps the second visible tab as follower", () => {
    let now = 1_000;
    const store = new MemoryLeaseStore();
    const a = new LeaderElection({ now: () => now, store, random: () => 0 }, {
      tabId: "a",
      leaseTtlMs: 5_000,
    });
    const b = new LeaderElection({ now: () => now, store, random: () => 0 }, {
      tabId: "b",
      leaseTtlMs: 5_000,
    });

    expect(a.step(true)).toBe("leader");
    expect(b.step(true)).toBe("follower");
    expect(store.read()?.leader).toBe("a");

    now += 1_000;
    expect(a.step(true)).toBe("leader");
    expect(b.step(true)).toBe("follower");
    expect(store.read()).toMatchObject({ leader: "a", visible: true });
  });

  it("keeps hidden tabs from claiming an empty lease until their grace expires", () => {
    let now = 10_000;
    const store = new MemoryLeaseStore();
    const hidden = new LeaderElection({ now: () => now, store, random: () => 0 }, {
      tabId: "hidden",
      hiddenGraceMs: 2_000,
      hiddenGraceJitterMs: 0,
      leaseTtlMs: 5_000,
    });

    expect(hidden.step(false)).toBe("follower");
    expect(store.read()).toBeNull();

    now += 1_999;
    expect(hidden.step(false)).toBe("follower");
    expect(store.read()).toBeNull();

    now += 1;
    expect(hidden.step(false)).toBe("leader");
    expect(store.read()).toMatchObject({ leader: "hidden", visible: false });
  });

  it("recovers leadership after the old leader lease expires", () => {
    let now = 50_000;
    const store = new MemoryLeaseStore();
    const leader = new LeaderElection({ now: () => now, store, random: () => 0 }, {
      tabId: "leader",
      leaseTtlMs: 1_000,
    });
    const follower = new LeaderElection({ now: () => now, store, random: () => 0 }, {
      tabId: "follower",
      leaseTtlMs: 1_000,
    });

    expect(leader.step(true)).toBe("leader");
    expect(follower.step(true)).toBe("follower");

    now += 1_001;
    expect(follower.step(true)).toBe("leader");
    expect(store.read()).toMatchObject({ leader: "follower" });
  });

  it("lets a visible tab preempt a hidden leader lease", () => {
    let now = 100_000;
    const store = new MemoryLeaseStore();
    const hidden = new LeaderElection({ now: () => now, store, random: () => 0 }, {
      tabId: "hidden",
      hiddenGraceMs: 0,
      hiddenGraceJitterMs: 0,
      leaseTtlMs: 5_000,
    });
    const visible = new LeaderElection({ now: () => now, store, random: () => 0 }, {
      tabId: "visible",
      leaseTtlMs: 5_000,
    });

    expect(hidden.step(false)).toBe("leader");
    expect(visible.step(true)).toBe("leader");
    expect(store.read()).toMatchObject({ leader: "visible", visible: true });
  });

  it("ignores corrupt lease storage so a visible tab can recover", () => {
    let raw = "{not-json";
    const storage = {
      getItem: vi.fn(() => raw),
      setItem: vi.fn((_key: string, value: string) => {
        raw = value;
      }),
      removeItem: vi.fn(() => {
        raw = "";
      }),
    };
    const store = createLeaseStore(storage, "lease");
    const election = new LeaderElection({ now: () => 1, store, random: () => 0 }, {
      tabId: "a",
      leaseTtlMs: 100,
    });

    expect(election.step(true)).toBe("leader");
    expect(JSON.parse(raw)).toMatchObject({ leader: "a" });
  });
});

describe("createStorageRelayShared", () => {
  it("delivers result messages through the localStorage relay fallback", () => {
    let storageListener: ((key: string | null, newValue: string | null) => void) | null = null;
    const seen: SharedMessage[] = [];
    const channel = createStorageRelayShared("relay", {
      storage: {
        setItem(key, value) {
          storageListener?.(key, value);
        },
      },
      onStorage(cb) {
        storageListener = cb;
        return () => {
          storageListener = null;
        };
      },
      nextNonce: () => "nonce-1",
    });

    const unsubscribe = channel.subscribe((message) => seen.push(message));
    channel.post({ type: "result", key: "company:live-runs", from: "leader", at: 123, data: [{ id: "run-1" }] });

    expect(seen).toEqual([
      { type: "result", key: "company:live-runs", from: "leader", at: 123, data: [{ id: "run-1" }] },
    ]);
    unsubscribe();
  });
});
