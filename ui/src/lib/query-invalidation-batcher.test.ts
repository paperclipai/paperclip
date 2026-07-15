import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  createCoalescingQueryClient,
  createInvalidationBatcher,
} from "./query-invalidation-batcher";

function fakeClient() {
  const calls: unknown[] = [];
  const client = {
    invalidateQueries: vi.fn((filters?: unknown) => {
      calls.push(filters);
      return Promise.resolve();
    }),
  };
  return { client, calls };
}

describe("createInvalidationBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces repeated invalidations of the same key into one call per window", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    for (let i = 0; i < 20; i++) batcher.schedule({ queryKey: ["dashboard", "c1"] });
    expect(client.invalidateQueries).not.toHaveBeenCalled(); // nothing until flush

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
    expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ["dashboard", "c1"] });
  });

  it("keeps distinct keys and distinct refetchType variants separate", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.schedule({ queryKey: ["b"] });
    batcher.schedule({ queryKey: ["a"] }); // dup of first
    batcher.schedule({ queryKey: ["a"], refetchType: "inactive" }); // distinct variant

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(3);
  });

  it("never coalesces predicate-based invalidations", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    // Two distinct predicate filters must both run — they can't be proven equal.
    batcher.schedule({ predicate: () => true });
    batcher.schedule({ predicate: () => false });

    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("schedule() resolves only after the flush has invalidated", async () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    let resolved = false;
    const p = batcher.schedule({ queryKey: ["a"] }).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false); // not yet — window still open
    expect(client.invalidateQueries).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    await p;
    expect(resolved).toBe(true);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh window after flushing", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);

    batcher.schedule({ queryKey: ["a"] });
    vi.advanceTimersByTime(300);
    expect(client.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("dispose cancels a pending flush", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.dispose();
    vi.advanceTimersByTime(1000);
    expect(client.invalidateQueries).not.toHaveBeenCalled();
  });

  it("flush() invalidates immediately", () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client, 300);

    batcher.schedule({ queryKey: ["a"] });
    batcher.flush();
    expect(client.invalidateQueries).toHaveBeenCalledTimes(1);
  });
});

describe("createCoalescingQueryClient", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("batches invalidateQueries but passes other methods straight through", () => {
    const setQueryData = vi.fn();
    const getQueryData = vi.fn(() => ({ some: "data" }));
    const realInvalidate = vi.fn(() => Promise.resolve());
    const real = { invalidateQueries: realInvalidate, setQueryData, getQueryData } as unknown as QueryClient;

    const batcher = createInvalidationBatcher(
      { invalidateQueries: realInvalidate } as unknown as QueryClient,
      300,
    );
    const proxied = createCoalescingQueryClient(real, batcher);

    // setQueryData / getQueryData pass through immediately.
    proxied.setQueryData(["k"], 1);
    expect(setQueryData).toHaveBeenCalledWith(["k"], 1);
    expect(proxied.getQueryData(["k"])).toEqual({ some: "data" });

    // invalidateQueries is deferred through the batcher.
    void proxied.invalidateQueries({ queryKey: ["k"] });
    void proxied.invalidateQueries({ queryKey: ["k"] });
    expect(realInvalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(300);
    expect(realInvalidate).toHaveBeenCalledTimes(1);
  });
});
