import { afterEach, describe, expect, it } from "vitest";
import {
  __resetProviderSemaphoreForTests,
  acquireProviderSlot,
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

describe("snapshotProviderSemaphore", () => {
  it("returns the current map state", async () => {
    const key = buildOpusSlotKey("company-i");
    await acquireProviderSlot(key, "run-1", 1);
    const queued = acquireProviderSlot(key, "run-2", 1).catch(() => undefined);
    await Promise.resolve();
    const snapshot = snapshotProviderSemaphore();
    expect(snapshot.inflight).toEqual([{ key, runIds: ["run-1"] }]);
    expect(snapshot.waiting).toEqual([{ key, runIds: ["run-2"] }]);
    releaseStaleInflightSlots();
    await queued;
  });
});
