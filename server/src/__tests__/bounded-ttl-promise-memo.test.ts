import { describe, expect, it, vi } from "vitest";
import { memoizePromise, type PromiseMemoEntry } from "../lib/bounded-ttl-promise-memo.js";

describe("memoizePromise", () => {
  it("reuses live entries and reloads expired entries", async () => {
    const cache = new Map<string, PromiseMemoEntry<number>>();
    const load = vi.fn(async () => load.mock.calls.length);

    await expect(memoizePromise({ cache, key: "issue", ttlMs: 100, maxEntries: 10, load, now: 0 })).resolves.toBe(1);
    await expect(memoizePromise({ cache, key: "issue", ttlMs: 100, maxEntries: 10, load, now: 99 })).resolves.toBe(1);
    await expect(memoizePromise({ cache, key: "issue", ttlMs: 100, maxEntries: 10, load, now: 100 })).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("evicts expired and oldest entries before exceeding the bound", async () => {
    const cache = new Map<string, PromiseMemoEntry<string>>();
    const load = (value: string) => async () => value;

    await memoizePromise({ cache, key: "expired", ttlMs: 10, maxEntries: 2, load: load("expired"), now: 0 });
    await memoizePromise({ cache, key: "current", ttlMs: 100, maxEntries: 2, load: load("current"), now: 20 });
    await memoizePromise({ cache, key: "next", ttlMs: 100, maxEntries: 2, load: load("next"), now: 20 });
    expect([...cache.keys()]).toEqual(["current", "next"]);

    await memoizePromise({ cache, key: "newest", ttlMs: 100, maxEntries: 2, load: load("newest"), now: 20 });
    expect([...cache.keys()]).toEqual(["next", "newest"]);
  });
});
