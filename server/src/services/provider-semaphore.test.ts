import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProviderSemaphoreForTests,
  acquireProviderSlot,
  bumpWaiterPriority,
  buildOpusSlotKey,
  getInflightCount,
  getWaiterCount,
  isOpusModel,
  releaseProviderSlot,
  releaseStaleInflightSlots,
  resolveOpusConcurrencyCapacity,
  shouldThrottleProviderRun,
  snapshotProviderSemaphore,
} from "./provider-semaphore.js";

afterEach(() => {
  __resetProviderSemaphoreForTests();
});

describe("isOpusModel", () => {
  it.each([
    ["claude-opus-4-7", true],
    ["claude-opus-4-6", true],
    ["us.anthropic.claude-opus-4-6-v1", true],
    ["claude-sonnet-4-6", false],
    ["claude-haiku-4-6", false],
    ["us.anthropic.claude-sonnet-4-5-20250929-v2:0", false],
    ["", false],
    [null, false],
    [undefined, false],
  ])("classifies %s as opus=%s", (model, expected) => {
    expect(isOpusModel(model)).toBe(expected);
  });
});

describe("shouldThrottleProviderRun", () => {
  it("only throttles claude_local + opus models", () => {
    expect(
      shouldThrottleProviderRun({
        adapterType: "claude_local",
        model: "claude-opus-4-7",
      }),
    ).toBe(true);
    expect(
      shouldThrottleProviderRun({
        adapterType: "claude_local",
        model: "claude-sonnet-4-6",
      }),
    ).toBe(false);
    expect(
      shouldThrottleProviderRun({
        adapterType: "codex_local",
        model: "claude-opus-4-7",
      }),
    ).toBe(false);
    expect(
      shouldThrottleProviderRun({
        adapterType: "claude_local",
        model: null,
      }),
    ).toBe(false);
  });
});

describe("resolveOpusConcurrencyCapacity", () => {
  it("uses default when metadata is missing or invalid", () => {
    expect(resolveOpusConcurrencyCapacity(null)).toBe(2);
    expect(resolveOpusConcurrencyCapacity(undefined)).toBe(2);
    expect(resolveOpusConcurrencyCapacity({})).toBe(2);
    expect(resolveOpusConcurrencyCapacity({ opusConcurrencyMax: "3" })).toBe(2);
    expect(
      resolveOpusConcurrencyCapacity({ opusConcurrencyMax: Number.NaN }),
    ).toBe(2);
  });

  it("clamps configured values to safe bounds", () => {
    expect(resolveOpusConcurrencyCapacity({ opusConcurrencyMax: 0 })).toBe(1);
    expect(resolveOpusConcurrencyCapacity({ opusConcurrencyMax: -5 })).toBe(1);
    expect(resolveOpusConcurrencyCapacity({ opusConcurrencyMax: 1000 })).toBe(
      32,
    );
    expect(resolveOpusConcurrencyCapacity({ opusConcurrencyMax: 5 })).toBe(5);
    expect(resolveOpusConcurrencyCapacity({ opusConcurrencyMax: 3.7 })).toBe(3);
  });
});

describe("acquire/release semaphore", () => {
  it("admits up to capacity, then queues additional acquires", async () => {
    const key = buildOpusSlotKey("company-a");
    const capacity = 2;

    await acquireProviderSlot(key, "run-1", capacity);
    await acquireProviderSlot(key, "run-2", capacity);
    expect(getInflightCount(key)).toBe(capacity);

    let run3Granted = false;
    const run3 = acquireProviderSlot(key, "run-3", capacity).then(() => {
      run3Granted = true;
    });

    // Give the microtask queue a chance to run; run-3 must remain pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(run3Granted).toBe(false);
    expect(getWaiterCount(key)).toBe(1);

    releaseProviderSlot(key, "run-1");
    await run3;
    expect(run3Granted).toBe(true);
    expect(getInflightCount(key)).toBe(capacity);
    expect(getWaiterCount(key)).toBe(0);
  });

  it("queues 6th simultaneous acquire when capacity is 5 (5-agent scenario)", async () => {
    const key = buildOpusSlotKey("company-b");
    const capacity = 5;

    const acquires = [
      acquireProviderSlot(key, "run-1", capacity),
      acquireProviderSlot(key, "run-2", capacity),
      acquireProviderSlot(key, "run-3", capacity),
      acquireProviderSlot(key, "run-4", capacity),
      acquireProviderSlot(key, "run-5", capacity),
    ];
    await Promise.all(acquires);
    expect(getInflightCount(key)).toBe(capacity);

    let sixthGranted = false;
    const sixth = acquireProviderSlot(key, "run-6", capacity).then(() => {
      sixthGranted = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sixthGranted).toBe(false);
    expect(getWaiterCount(key)).toBe(1);
    expect(getInflightCount(key)).toBe(capacity);

    releaseProviderSlot(key, "run-3");
    await sixth;
    expect(sixthGranted).toBe(true);
    expect(getInflightCount(key)).toBe(capacity);
    expect(getWaiterCount(key)).toBe(0);

    // Cleanup so subsequent tests start clean.
    for (const id of ["run-1", "run-2", "run-4", "run-5", "run-6"]) {
      releaseProviderSlot(key, id);
    }
    expect(getInflightCount(key)).toBe(0);
  });

  it("preserves FIFO ordering when multiple waiters are queued", async () => {
    const key = buildOpusSlotKey("company-c");
    const capacity = 1;
    await acquireProviderSlot(key, "holder", capacity);

    const order: string[] = [];
    const w1 = acquireProviderSlot(key, "w1", capacity).then(() => {
      order.push("w1");
      releaseProviderSlot(key, "w1");
    });
    const w2 = acquireProviderSlot(key, "w2", capacity).then(() => {
      order.push("w2");
      releaseProviderSlot(key, "w2");
    });
    const w3 = acquireProviderSlot(key, "w3", capacity).then(() => {
      order.push("w3");
      releaseProviderSlot(key, "w3");
    });

    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(3);
    releaseProviderSlot(key, "holder");

    await Promise.all([w1, w2, w3]);
    expect(order).toEqual(["w1", "w2", "w3"]);
    expect(getInflightCount(key)).toBe(0);
  });

  it("isolates inflight sets per company key", async () => {
    const keyA = buildOpusSlotKey("company-d");
    const keyB = buildOpusSlotKey("company-e");
    await acquireProviderSlot(keyA, "run-1", 1);
    await acquireProviderSlot(keyB, "run-1", 1);
    expect(getInflightCount(keyA)).toBe(1);
    expect(getInflightCount(keyB)).toBe(1);
    releaseProviderSlot(keyA, "run-1");
    expect(getInflightCount(keyA)).toBe(0);
    expect(getInflightCount(keyB)).toBe(1);
  });

  it("re-entrant acquire on the same runId is a no-op", async () => {
    const key = buildOpusSlotKey("company-f");
    await acquireProviderSlot(key, "run-1", 2);
    await acquireProviderSlot(key, "run-1", 2);
    expect(getInflightCount(key)).toBe(1);
    releaseProviderSlot(key, "run-1");
    expect(getInflightCount(key)).toBe(0);
  });

  it("supports AbortSignal to cancel a queued waiter", async () => {
    const key = buildOpusSlotKey("company-g");
    await acquireProviderSlot(key, "holder", 1);
    const controller = new AbortController();
    const cancelled = acquireProviderSlot(key, "waiter", 1, {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(1);
    controller.abort(new Error("test cancel"));
    await expect(cancelled).rejects.toThrow("test cancel");
    expect(getWaiterCount(key)).toBe(0);
    releaseProviderSlot(key, "holder");
  });
});

describe("releaseStaleInflightSlots", () => {
  it("clears any leftover inflight set and rejects pending waiters", async () => {
    const key = buildOpusSlotKey("company-h");
    await acquireProviderSlot(key, "run-1", 1);
    const queued = acquireProviderSlot(key, "run-2", 1);
    await Promise.resolve();
    const result = releaseStaleInflightSlots();
    expect(result.inflightCleared).toBe(1);
    expect(result.waitersRejected).toBe(1);
    await expect(queued).rejects.toThrow(
      "provider semaphore reset on bootstrap",
    );
    expect(getInflightCount(key)).toBe(0);
    expect(getWaiterCount(key)).toBe(0);
  });
});

describe("priority-aware ordering (PMSA-17)", () => {
  it("serves p0 waiters before p2 waiters even when p2 enqueued first", async () => {
    const key = buildOpusSlotKey("company-prio-1");
    const capacity = 1;
    await acquireProviderSlot(key, "holder", capacity);

    const order: string[] = [];
    const lowFirst = acquireProviderSlot(key, "p2-first", capacity, {
      priorityTier: "p2",
    }).then(() => {
      order.push("p2-first");
      releaseProviderSlot(key, "p2-first");
    });
    const highSecond = acquireProviderSlot(key, "p0-second", capacity, {
      priorityTier: "p0",
    }).then(() => {
      order.push("p0-second");
      releaseProviderSlot(key, "p0-second");
    });
    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(2);

    releaseProviderSlot(key, "holder");
    await Promise.all([lowFirst, highSecond]);
    expect(order).toEqual(["p0-second", "p2-first"]);
  });

  it("preserves FIFO within the same tier", async () => {
    const key = buildOpusSlotKey("company-prio-2");
    const capacity = 1;
    await acquireProviderSlot(key, "holder", capacity);

    const order: string[] = [];
    const a = acquireProviderSlot(key, "p1-a", capacity, {
      priorityTier: "p1",
    }).then(() => {
      order.push("p1-a");
      releaseProviderSlot(key, "p1-a");
    });
    const b = acquireProviderSlot(key, "p1-b", capacity, {
      priorityTier: "p1",
    }).then(() => {
      order.push("p1-b");
      releaseProviderSlot(key, "p1-b");
    });
    const c = acquireProviderSlot(key, "p1-c", capacity, {
      priorityTier: "p1",
    }).then(() => {
      order.push("p1-c");
      releaseProviderSlot(key, "p1-c");
    });
    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(3);

    releaseProviderSlot(key, "holder");
    await Promise.all([a, b, c]);
    expect(order).toEqual(["p1-a", "p1-b", "p1-c"]);
  });

  it("p0 waiter cuts ahead of an already-queued p3 plus a fresh p2", async () => {
    // Five-agent dogfood scenario: p3 researcher heartbeat, p2 PRD writer,
    // and a p0 CEO decision all converge on a single Opus slot. CEO must
    // run first regardless of arrival order.
    const key = buildOpusSlotKey("company-prio-3");
    const capacity = 1;
    await acquireProviderSlot(key, "holder", capacity);

    const order: string[] = [];
    const p3 = acquireProviderSlot(key, "researcher", capacity, {
      priorityTier: "p3",
    }).then(() => {
      order.push("researcher");
      releaseProviderSlot(key, "researcher");
    });
    const p2 = acquireProviderSlot(key, "prd-writer", capacity, {
      priorityTier: "p2",
    }).then(() => {
      order.push("prd-writer");
      releaseProviderSlot(key, "prd-writer");
    });
    const p0 = acquireProviderSlot(key, "ceo", capacity, {
      priorityTier: "p0",
    }).then(() => {
      order.push("ceo");
      releaseProviderSlot(key, "ceo");
    });
    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(3);

    releaseProviderSlot(key, "holder");
    await Promise.all([p3, p2, p0]);
    expect(order).toEqual(["ceo", "prd-writer", "researcher"]);
  });

  it("falls back to p2 when no priorityTier is supplied", async () => {
    const key = buildOpusSlotKey("company-prio-4");
    await acquireProviderSlot(key, "holder", 1);
    const queued = acquireProviderSlot(key, "default-tier", 1).catch(
      () => undefined,
    );
    await Promise.resolve();
    const snap = snapshotProviderSemaphore();
    const matching = snap.waiting.find((row) => row.key === key);
    expect(matching?.tiers).toEqual(["p2"]);
    releaseStaleInflightSlots();
    await queued;
  });
});

describe("aging promotes starved waiters (PMSA-17)", () => {
  it("treats a p3 waiter that has waited > aging interval as p2 on next pick", async () => {
    const key = buildOpusSlotKey("company-aging-1");
    const capacity = 1;
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const agingIntervalMs = 60_000; // 1 min for test simplicity

    await acquireProviderSlot(key, "holder", capacity);

    // Two waiters arrive at the same instant: one p3, one p2.
    const order: string[] = [];
    const old = acquireProviderSlot(key, "old-p3", capacity, {
      priorityTier: "p3",
      agingIntervalMs,
      now,
    }).then(() => {
      order.push("old-p3");
      releaseProviderSlot(key, "old-p3", { agingIntervalMs, now });
    });
    await Promise.resolve();

    nowMs += agingIntervalMs + 100; // p3 has now waited > 1 interval
    const fresh = acquireProviderSlot(key, "fresh-p2", capacity, {
      priorityTier: "p2",
      agingIntervalMs,
      now,
    }).then(() => {
      order.push("fresh-p2");
      releaseProviderSlot(key, "fresh-p2", { agingIntervalMs, now });
    });
    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(2);

    // The aged p3 (now effectively p2) was enqueued first, so FIFO within p2
    // promotes it ahead of the freshly-arrived p2.
    releaseProviderSlot(key, "holder", { agingIntervalMs, now });
    await Promise.all([old, fresh]);
    expect(order).toEqual(["old-p3", "fresh-p2"]);
  });

  it("walks p3 -> p2 -> p1 -> p0 across multiple aging intervals", async () => {
    const key = buildOpusSlotKey("company-aging-2");
    const capacity = 1;
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const agingIntervalMs = 60_000;
    await acquireProviderSlot(key, "holder", capacity);

    const aged = acquireProviderSlot(key, "aged-p3", capacity, {
      priorityTier: "p3",
      agingIntervalMs,
      now,
    });
    await Promise.resolve();

    // Wait long enough for 3 aging steps (p3 -> p2 -> p1 -> p0).
    nowMs += agingIntervalMs * 3 + 100;

    let fresh0Resolved = false;
    const fresh0 = acquireProviderSlot(key, "fresh-p0", capacity, {
      priorityTier: "p0",
      agingIntervalMs,
      now,
    }).then(() => {
      fresh0Resolved = true;
      releaseProviderSlot(key, "fresh-p0", { agingIntervalMs, now });
    });
    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(2);

    releaseProviderSlot(key, "holder", { agingIntervalMs, now });
    await aged;
    // The aged p3 has been promoted to p0 by aging; it shares tier with the
    // fresh p0, and (within tier) FIFO breaks the tie in favour of the older
    // entry. Fresh p0 still runs second, not blocked indefinitely.
    expect(fresh0Resolved).toBe(false);
    releaseProviderSlot(key, "aged-p3", { agingIntervalMs, now });
    await fresh0;
  });

  it("bumpWaiterPriority shortcuts the timer-based aging path", async () => {
    const key = buildOpusSlotKey("company-aging-3");
    await acquireProviderSlot(key, "holder", 1);
    const order: string[] = [];
    const low = acquireProviderSlot(key, "p3-bumped", 1, {
      priorityTier: "p3",
    }).then(() => {
      order.push("p3-bumped");
      releaseProviderSlot(key, "p3-bumped");
    });
    const mid = acquireProviderSlot(key, "p2-stable", 1, {
      priorityTier: "p2",
    }).then(() => {
      order.push("p2-stable");
      releaseProviderSlot(key, "p2-stable");
    });
    await Promise.resolve();
    expect(getWaiterCount(key)).toBe(2);

    // p3 -> p2 (tied) keeps FIFO (p3-bumped enqueued first), then p2 -> p1
    // pushes it ahead of the stable p2.
    expect(bumpWaiterPriority(key, "p3-bumped")).toEqual({
      promoted: true,
      tier: "p2",
    });
    expect(bumpWaiterPriority(key, "p3-bumped")).toEqual({
      promoted: true,
      tier: "p1",
    });

    releaseProviderSlot(key, "holder");
    await Promise.all([low, mid]);
    expect(order).toEqual(["p3-bumped", "p2-stable"]);
  });

  it("bumpWaiterPriority no-ops at p0", async () => {
    const key = buildOpusSlotKey("company-aging-4");
    await acquireProviderSlot(key, "holder", 1);
    const queued = acquireProviderSlot(key, "p0-already", 1, {
      priorityTier: "p0",
    }).catch(() => undefined);
    await Promise.resolve();
    expect(bumpWaiterPriority(key, "p0-already")).toEqual({
      promoted: false,
      tier: "p0",
    });
    releaseStaleInflightSlots();
    await queued;
  });

  it("returns release telemetry for a promoted waiter", async () => {
    const key = buildOpusSlotKey("company-aging-5");
    let nowMs = 1_000_000;
    const now = () => nowMs;
    const agingIntervalMs = 60_000;
    await acquireProviderSlot(key, "holder", 1);
    const queued = acquireProviderSlot(key, "waiter-1", 1, {
      priorityTier: "p3",
      agingIntervalMs,
      now,
    });
    await Promise.resolve();
    nowMs += agingIntervalMs + 50;
    const result = releaseProviderSlot(key, "holder", { agingIntervalMs, now });
    expect(result.promotedRunId).toBe("waiter-1");
    expect(result.promotedInitialTier).toBe("p3");
    expect(result.promotedTier).toBe("p2");
    expect(result.promotedWaitedMs).toBe(agingIntervalMs + 50);
    await queued;
    releaseProviderSlot(key, "waiter-1", { agingIntervalMs, now });
  });
});

describe("snapshotProviderSemaphore", () => {
  it("returns the current map state", async () => {
    const key = buildOpusSlotKey("company-i");
    await acquireProviderSlot(key, "run-1", 1);
    const queued = acquireProviderSlot(key, "run-2", 1).catch(() => undefined);
    await Promise.resolve();
    const snapshot = snapshotProviderSemaphore();
    expect(snapshot.inflight).toEqual([{ key, runIds: ["run-1"] }]);
    expect(snapshot.waiting).toEqual([
      { key, runIds: ["run-2"], tiers: ["p2"] },
    ]);
    releaseStaleInflightSlots();
    await queued;
  });
});
