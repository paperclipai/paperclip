import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
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
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("marks queries stale without refetching when the tab hides before flush", async () => {
    const { client } = fakeClient();
    const batcher = createInvalidationBatcher(client);
    const pending = batcher.schedule({ queryKey: ["dashboard", "c1"] });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    await batcher.flush();
    await pending;
    expect(client.invalidateQueries).toHaveBeenCalledExactlyOnceWith({ queryKey: ["dashboard", "c1"], refetchType: "none" });
  });

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
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

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

describe("overlapping live invalidations", () => {
  it.each([false, true])("does not restart a request already covered by its collection invalidation (child first=%s)", async childFirst => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    const key = ["issues", "company-1", "mine-by-me", "index"];
    client.setQueryData(key, "cached");
    const completions: Array<() => void> = [];
    const aborted = vi.fn();
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<string>((resolve, reject) => {
      completions.push(() => resolve("fresh"));
      signal.addEventListener("abort", () => { aborted(); reject(signal.reason); }, { once: true });
    }));
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => undefined);
    const batcher = createInvalidationBatcher(client);
    try {
      const filters = [{ queryKey: ["issues", "company-1"] }, { queryKey: ["issues", "company-1", "mine-by-me"] }];
      for (const filter of childFirst ? filters.reverse() : filters) void batcher.schedule(filter);
      const flushed = batcher.flush();
      completions.forEach(complete => complete());
      await flushed;
      expect(client.getQueryData(key)).toBe("fresh");
      expect(read).toHaveBeenCalledOnce();
      expect(aborted).not.toHaveBeenCalled();
    } finally {
      batcher.dispose();
      unsubscribe();
      client.clear();
    }
  });

  it.each(["exact", "type", "stale", "refetch", "predicate"])("preserves a child refresh when the parent has a different %s constraint", async constraint => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    const key = ["issues", "company-1", "mine-by-me"];
    client.setQueryData(key, "cached");
    const read = vi.fn(async () => "fresh");
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => undefined);
    const batcher = createInvalidationBatcher(client);
    try {
      const parent = {
        queryKey: ["issues", "company-1"],
        ...(constraint === "exact" ? { exact: true } : {}),
        ...(constraint === "type" ? { type: "inactive" as const } : {}),
        ...(constraint === "stale" ? { stale: true } : {}),
        ...(constraint === "refetch" ? { refetchType: "none" as const } : {}),
        ...(constraint === "predicate" ? { predicate: () => false } : {}),
      };
      void batcher.schedule(parent);
      void batcher.schedule({ queryKey: key });
      await batcher.flush();
      expect(client.getQueryData(key)).toBe("fresh");
      expect(read).toHaveBeenCalledOnce();
    } finally {
      batcher.dispose();
      unsubscribe();
      client.clear();
    }
  });

  it.each(["stale", "fetchStatus"])("retains distinct %s filters on the same key", async constraint => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    const key = ["issues", "company-1"];
    client.setQueryData(key, "cached");
    const observer = new QueryObserver(client, { queryKey: key, queryFn: async () => "fresh" });
    const unsubscribe = observer.subscribe(() => undefined);
    const batcher = createInvalidationBatcher(client);
    try {
      if (constraint === "stale") {
        void batcher.schedule({ queryKey: key, stale: false });
        void batcher.schedule({ queryKey: key, stale: true });
      } else {
        void batcher.schedule({ queryKey: key, fetchStatus: "idle" });
        void batcher.schedule({ queryKey: key, fetchStatus: "paused" });
      }
      await batcher.flush();
      expect(client.getQueryData(key)).toBe("fresh");
    } finally {
      batcher.dispose();
      unsubscribe();
      client.clear();
    }
  });

  it("starts a newer read when another event arrives in a later batch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    const key = ["issues", "company-1", "mine-by-me"];
    client.setQueryData(key, 0);
    let serverValue = 1;
    const completions: Array<() => void> = [];
    const read = vi.fn(({ signal }: { signal: AbortSignal }) => new Promise<number>((resolve, reject) => {
      const snapshot = serverValue;
      completions.push(() => resolve(snapshot));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const observer = new QueryObserver(client, { queryKey: key, queryFn: read });
    const unsubscribe = observer.subscribe(() => undefined);
    const batcher = createInvalidationBatcher(client);
    try {
      void batcher.schedule({ queryKey: ["issues", "company-1"] });
      const first = batcher.flush();
      serverValue = 2;
      void batcher.schedule({ queryKey: key });
      const second = batcher.flush();
      completions.forEach(complete => complete());
      await Promise.all([first, second]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(key)).toBe(2);
    } finally {
      batcher.dispose();
      unsubscribe();
      client.clear();
    }
  });
});
