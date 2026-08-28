import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LeaderElection,
  SharedPollingCoordinator,
  createLeaseStore,
  createStorageRelayShared,
  type LeaseStore,
  type SharedChannel,
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

class MemorySharedChannel implements SharedChannel {
  posts: SharedMessage[] = [];
  private handler: ((message: SharedMessage) => void) | null = null;

  post(message: SharedMessage) {
    this.posts.push(message);
  }

  subscribe(handler: (message: SharedMessage) => void) {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  emit(message: SharedMessage) {
    this.handler?.(message);
  }

  close() {}
}

function startLeaderCoordinator(channel: MemorySharedChannel) {
  const store = new MemoryLeaseStore();
  const election = new LeaderElection({ now: () => Date.now(), store, random: () => 0 }, {
    tabId: "leader",
    leaseTtlMs: 10_000,
  });
  const coordinator = new SharedPollingCoordinator("company-1", {
    tabId: "leader",
    channel,
    election,
    tickMs: 10_000,
    publishDebounceMs: 1_000,
    now: () => Date.now(),
    getVisible: () => true,
  });
  coordinator.start();
  expect(coordinator.getSnapshot().isLeader).toBe(true);
  return coordinator;
}

function getCoordinatorCaches(coordinator: SharedPollingCoordinator) {
  return coordinator as unknown as {
    latestResults: Map<string, unknown>;
    lastPublished: Map<string, unknown>;
  };
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

describe("SharedPollingCoordinator", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dedupes same-resource publishes and rate limits trailing result broadcasts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const channel = new MemorySharedChannel();
    const coordinator = startLeaderCoordinator(channel);

    coordinator.publish("company:live-runs", [{ id: "run-1", lastEventAt: "a" }], 100);
    expect(channel.posts.filter((message) => message.type === "result")).toEqual([
      {
        type: "result",
        key: "company:live-runs",
        from: "leader",
        at: 1_000,
        dataUpdatedAt: 100,
        data: [{ id: "run-1", lastEventAt: "a" }],
      },
    ]);

    coordinator.publish("company:live-runs", [{ lastEventAt: "a", id: "run-1" }], 100);
    coordinator.publish("company:live-runs", [{ id: "run-1", lastEventAt: "a" }], 101);
    expect(channel.posts.filter((message) => message.type === "result")).toHaveLength(1);

    vi.setSystemTime(1_200);
    coordinator.publish("company:live-runs", [{ id: "run-1", lastEventAt: "b" }], 200);
    coordinator.publish("company:live-runs", [{ id: "run-1", lastEventAt: "b" }], 200);
    expect(channel.posts.filter((message) => message.type === "result")).toHaveLength(1);

    vi.advanceTimersByTime(799);
    expect(channel.posts.filter((message) => message.type === "result")).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(channel.posts.filter((message) => message.type === "result")).toHaveLength(2);
    expect(channel.posts.at(-1)).toEqual({
      type: "result",
      key: "company:live-runs",
      from: "leader",
      at: 2_000,
      dataUpdatedAt: 200,
      data: [{ id: "run-1", lastEventAt: "b" }],
    });

    coordinator.stop();
  });

  it("preserves original result timestamps when reposting the latest result for a request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const channel = new MemorySharedChannel();
    const coordinator = startLeaderCoordinator(channel);

    coordinator.publish("company:live-runs", [{ id: "run-1" }], 123);
    const original = channel.posts[0];

    vi.setSystemTime(9_000);
    channel.emit({ type: "request", key: "company:live-runs", from: "follower", at: 9_000 });

    expect(channel.posts[1]).toEqual({ ...original, from: "leader" });
    expect(channel.posts[1]?.at).toBe(5_000);
    expect(channel.posts[1]?.dataUpdatedAt).toBe(123);

    coordinator.stop();
  });

  it("bounds cached results with LRU eviction and removes idle entries on ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const channel = new MemorySharedChannel();
    const coordinator = startLeaderCoordinator(channel);

    for (let index = 1; index <= 32; index += 1) {
      coordinator.publish(`company:resource-${index}`, { index }, index);
    }
    channel.emit({ type: "request", key: "company:resource-1", from: "follower", at: 1_000 });
    coordinator.publish("company:resource-1", { index: 1, refreshed: true }, 33);
    coordinator.publish("company:resource-33", { index: 33 }, 34);

    const caches = getCoordinatorCaches(coordinator);
    expect(caches.latestResults.size).toBe(32);
    expect(caches.lastPublished.size).toBe(32);
    expect(caches.latestResults.has("company:resource-1")).toBe(true);
    expect(caches.lastPublished.has("company:resource-1")).toBe(true);
    expect(caches.latestResults.has("company:resource-2")).toBe(false);
    expect(caches.lastPublished.has("company:resource-2")).toBe(false);

    vi.advanceTimersByTime(5 * 60_000 + 10_000);
    expect(caches.latestResults.size).toBe(0);
    expect(caches.lastPublished.size).toBe(0);

    coordinator.stop();
  });

  it("retains listenerless broadcasts through quick resource resubscriptions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const channel = new MemorySharedChannel();
    const coordinator = startLeaderCoordinator(channel);
    const message = {
      type: "result" as const,
      key: "company:live-runs",
      from: "follower",
      at: 1_000,
      dataUpdatedAt: 100,
      data: [{ id: "run-1" }],
    };

    channel.emit(message);
    expect(getCoordinatorCaches(coordinator).latestResults.size).toBe(1);

    const firstListener = vi.fn();
    const unsubscribe = coordinator.subscribeResource(message.key, firstListener);
    expect(firstListener).toHaveBeenCalledWith(message);
    expect(getCoordinatorCaches(coordinator).latestResults.size).toBe(1);

    unsubscribe();
    expect(getCoordinatorCaches(coordinator).latestResults.size).toBe(1);

    const remountedListener = vi.fn();
    const unsubscribeRemounted = coordinator.subscribeResource(message.key, remountedListener);
    expect(remountedListener).toHaveBeenCalledWith(message);

    unsubscribeRemounted();
    vi.advanceTimersByTime(5 * 60_000 + 10_000);
    expect(getCoordinatorCaches(coordinator).latestResults.size).toBe(0);

    coordinator.stop();
  });

  it("keeps active publish dedupe entries when inactive keys exceed the cache limit", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const channel = new MemorySharedChannel();
    const coordinator = startLeaderCoordinator(channel);
    const unsubscribe = coordinator.subscribeResource("company:resource-1", vi.fn());

    for (let index = 1; index <= 33; index += 1) {
      coordinator.publish(`company:resource-${index}`, { index }, index);
    }
    coordinator.publish("company:resource-1", { index: 1 }, 34);

    expect(channel.posts.filter((message) => message.type === "result")).toHaveLength(33);
    const caches = getCoordinatorCaches(coordinator);
    expect(caches.latestResults.size).toBe(33);
    expect(caches.lastPublished.size).toBe(33);
    expect(caches.lastPublished.has("company:resource-1")).toBe(true);

    vi.advanceTimersByTime(5 * 60_000 + 10_000);
    expect(caches.latestResults.size).toBe(1);
    expect(caches.lastPublished.size).toBe(1);
    coordinator.publish("company:resource-1", { index: 1 }, 35);
    expect(channel.posts.filter((message) => message.type === "result")).toHaveLength(33);

    unsubscribe();
    vi.advanceTimersByTime(5 * 60_000 - 1);
    expect(caches.latestResults.size).toBe(1);
    expect(caches.lastPublished.size).toBe(1);
    vi.advanceTimersByTime(10_001);
    expect(caches.latestResults.size).toBe(0);
    expect(caches.lastPublished.size).toBe(0);

    coordinator.stop();
  });

  it("skips fingerprint traversal for older-or-equal publish snapshots", () => {
    const channel = new MemorySharedChannel();
    const coordinator = startLeaderCoordinator(channel);
    const ownKeys = vi.fn(() => []);
    const staleData = new Proxy({}, { ownKeys });

    coordinator.publish("company:live-runs", [{ id: "run-1" }], 100);
    coordinator.publish("company:live-runs", staleData, 100);

    expect(ownKeys).not.toHaveBeenCalled();
    expect(channel.posts.filter((message) => message.type === "result")).toHaveLength(1);

    coordinator.stop();
  });
});
