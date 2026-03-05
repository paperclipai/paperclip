import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Inline a minimal batched event system for testing the pattern.
// This avoids importing from workspace packages.

function createBatchedEventSystem(flushIntervalMs = 50, maxBatchSize = 100) {
  type Event = { id: number; companyId: string; type: string; payload: Record<string, unknown> };
  type BatchListener = (events: Event[]) => void;

  let nextId = 0;
  const listeners = new Map<string, Set<BatchListener>>();
  const buffers = new Map<string, Event[]>();
  let flushTimer: ReturnType<typeof setInterval> | null = null;

  function flushAll() {
    for (const [companyId, events] of buffers) {
      if (events.length === 0) continue;
      buffers.set(companyId, []);
      const companyListeners = listeners.get(companyId);
      if (companyListeners) {
        for (const listener of companyListeners) {
          listener(events);
        }
      }
    }
  }

  function publish(companyId: string, type: string, payload: Record<string, unknown> = {}) {
    nextId++;
    const event: Event = { id: nextId, companyId, type, payload };
    let buffer = buffers.get(companyId);
    if (!buffer) {
      buffer = [];
      buffers.set(companyId, buffer);
    }
    buffer.push(event);
    if (buffer.length >= maxBatchSize) {
      // Flush immediately for this company.
      buffers.set(companyId, []);
      const companyListeners = listeners.get(companyId);
      if (companyListeners) {
        for (const listener of companyListeners) {
          listener([...buffer]);
        }
      }
    }
    return event;
  }

  function subscribe(companyId: string, listener: BatchListener) {
    let set = listeners.get(companyId);
    if (!set) {
      set = new Set();
      listeners.set(companyId, set);
    }
    set.add(listener);
    if (!flushTimer) {
      flushTimer = setInterval(flushAll, flushIntervalMs);
    }
    return () => {
      set?.delete(listener);
      if (set?.size === 0) listeners.delete(companyId);
      if (listeners.size === 0 && flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
      }
    };
  }

  return { publish, subscribe, flushAll, getBufferSize: (id: string) => buffers.get(id)?.length ?? 0 };
}

describe("live-events-batched", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers events and flushes on interval", async () => {
    const system = createBatchedEventSystem(50);
    const received: Array<Array<{ id: number }>> = [];

    system.subscribe("company-1", (batch) => received.push(batch));

    system.publish("company-1", "agent.started");
    system.publish("company-1", "agent.log");
    system.publish("company-1", "agent.log");

    // Events are buffered, not yet delivered.
    expect(received).toHaveLength(0);

    // Advance past the flush interval.
    vi.advanceTimersByTime(50);

    // Now all 3 events should arrive as a single batch.
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(3);
  });

  it("delivers to correct company only", () => {
    const system = createBatchedEventSystem(50);
    const company1Events: unknown[] = [];
    const company2Events: unknown[] = [];

    system.subscribe("company-1", (batch) => company1Events.push(...batch));
    system.subscribe("company-2", (batch) => company2Events.push(...batch));

    system.publish("company-1", "event-a");
    system.publish("company-2", "event-b");

    vi.advanceTimersByTime(50);

    expect(company1Events).toHaveLength(1);
    expect(company2Events).toHaveLength(1);
  });

  it("flushes immediately when batch size is exceeded", () => {
    const system = createBatchedEventSystem(50, 3); // maxBatchSize = 3
    const received: Array<Array<{ id: number }>> = [];

    system.subscribe("company-1", (batch) => received.push(batch));

    system.publish("company-1", "event-1");
    system.publish("company-1", "event-2");

    // Not yet flushed — under max.
    expect(received).toHaveLength(0);

    // Third event triggers immediate flush.
    system.publish("company-1", "event-3");
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(3);
  });

  it("unsubscribe stops delivery", () => {
    const system = createBatchedEventSystem(50);
    const received: unknown[] = [];

    const unsub = system.subscribe("company-1", (batch) => received.push(...batch));
    system.publish("company-1", "event-1");
    unsub();

    vi.advanceTimersByTime(50);

    // Should not receive the event after unsubscribe.
    expect(received).toHaveLength(0);
  });

  it("flushAll delivers all pending events immediately", () => {
    const system = createBatchedEventSystem(50);
    const received: unknown[] = [];

    system.subscribe("company-1", (batch) => received.push(...batch));
    system.publish("company-1", "event-1");
    system.publish("company-1", "event-2");

    // Don't advance time — call flushAll directly.
    system.flushAll();

    expect(received).toHaveLength(2);
  });

  it("handles no subscribers gracefully", () => {
    const system = createBatchedEventSystem(50);

    // Publishing with no subscribers should not throw.
    expect(() => system.publish("no-one-listening", "event-1")).not.toThrow();

    // Buffer has 1 event, but no flush timer is running (no subscribers).
    expect(system.getBufferSize("no-one-listening")).toBe(1);

    // Explicit flushAll still clears the buffer even without subscribers.
    system.flushAll();
    expect(system.getBufferSize("no-one-listening")).toBe(0);
  });

  it("multiple subscribers receive the same batch", () => {
    const system = createBatchedEventSystem(50);
    const listener1: unknown[] = [];
    const listener2: unknown[] = [];

    system.subscribe("company-1", (batch) => listener1.push(...batch));
    system.subscribe("company-1", (batch) => listener2.push(...batch));

    system.publish("company-1", "event-1");
    vi.advanceTimersByTime(50);

    expect(listener1).toHaveLength(1);
    expect(listener2).toHaveLength(1);
  });

  it("increments event IDs", () => {
    const system = createBatchedEventSystem(50);

    const e1 = system.publish("company-1", "a");
    const e2 = system.publish("company-1", "b");
    const e3 = system.publish("company-2", "c");

    expect(e2.id).toBeGreaterThan(e1.id);
    expect(e3.id).toBeGreaterThan(e2.id);
  });
});
