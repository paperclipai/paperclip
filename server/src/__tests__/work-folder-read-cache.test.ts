import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createWorkFolderReadCache } from "../services/work-folder-read-cache.js";
import type { WorkTreeEntry } from "../services/work-folder-transport.js";

function entry(path: string, byteSize = 1): WorkTreeEntry {
  return { path, kind: "file", byteSize, sha256: "a".repeat(64), executable: false };
}
async function consume(stream: Readable) {
  return Buffer.concat(await stream.toArray());
}
const bytes = (entries: WorkTreeEntry[]) => entries.map((entry) => Buffer.alloc(entry.byteSize, "x"));

describe("checkpoint small-file read cache", () => {
  it("loads lazily, coalesces concurrent paths and always reopens a repeated path", async () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const load = vi.fn(async (group: WorkTreeEntry[]) => bytes(group));
    const fallback = vi.fn(() => Readable.from([Buffer.from("fresh")]));
    const cache = createWorkFolderReadCache(entries, load, fallback);
    const a = cache.read(entries[0]!), b = cache.read(entries[1]!);
    expect(load).not.toHaveBeenCalled();
    expect((await Promise.all([consume(a), consume(b)])).map((value) => value.toString())).toEqual(["x", "x"]);
    expect(await consume(cache.read(entries[2]!))).toEqual(Buffer.from("x"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(await consume(cache.read(entries[0]!))).toEqual(Buffer.from("fresh"));
    expect(fallback).toHaveBeenCalledTimes(1);
    cache.clear();
  });

  it("bounds groups by byte size and count, including empty files, and streams larger files", async () => {
    const entries = [entry("large", 1024 * 1024 + 1), entry("full", 1024 * 1024), entry("next", 1),
      ...Array.from({ length: 129 }, (_, i) => entry(`empty-${i}`, 0))];
    const load = vi.fn(async (group: WorkTreeEntry[]) => bytes(group));
    const fallback = vi.fn(() => Readable.from([Buffer.from("large-stream")]));
    const cache = createWorkFolderReadCache(entries, load, fallback);
    for (const value of entries) await consume(cache.read(value));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith(entries[0]);
    expect(load).toHaveBeenCalledTimes(4);
    for (const [group] of load.mock.calls) {
      expect(group.length).toBeLessThanOrEqual(64);
      expect(group.reduce((sum, value) => sum + value.byteSize, 0)).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(load.mock.calls.flatMap(([group]) => group.map((value) => value.path))).toEqual(entries.slice(1).map((value) => value.path));
    cache.clear();
  });

  it("retains only four least-recently-used groups even when most grouped files are never requested", async () => {
    const entries = Array.from({ length: 10 }, (_, i) => entry(`file-${i}`, 512 * 1024));
    const load = vi.fn(async (group: WorkTreeEntry[]) => bytes(group));
    const cache = createWorkFolderReadCache(entries, load, () => { throw new Error("unexpected fallback"); });
    for (const index of [0, 2, 4, 6]) await consume(cache.read(entries[index]!));
    // Touch the first group, then create a fifth: group two is now the LRU.
    await consume(cache.read(entries[1]!));
    await consume(cache.read(entries[8]!));
    expect(load).toHaveBeenCalledTimes(5);
    await consume(cache.read(entries[5]!));
    expect(load).toHaveBeenCalledTimes(5);
    await consume(cache.read(entries[3]!));
    expect(load).toHaveBeenCalledTimes(6);
    expect(load.mock.calls.at(-1)![0].map((value) => value.path)).toEqual(["file-2", "file-3"]);
    cache.clear();
  });

  it("uses a fresh source after a rejected load and allows untouched paths to reload their failed group", async () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const load = vi.fn(async (group: WorkTreeEntry[]) => bytes(group)).mockRejectedValueOnce(new Error("read failed"));
    const fallback = vi.fn(() => Readable.from([Buffer.from("fresh")]));
    const cache = createWorkFolderReadCache(entries, load, fallback);
    const results = await Promise.allSettled([consume(cache.read(entries[0]!)), consume(cache.read(entries[1]!))]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await consume(cache.read(entries[0]!))).toEqual(Buffer.from("fresh"));
    expect(await consume(cache.read(entries[2]!))).toEqual(Buffer.from("x"));
    expect(load).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveBeenCalledTimes(1);
    cache.clear();
  });

  it("clear releases cached groups and sends existing lazy and future readers to fresh streams", async () => {
    const entries = [entry("a"), entry("b"), entry("c")];
    const load = vi.fn(async (group: WorkTreeEntry[]) => bytes(group));
    const sources: Readable[] = [];
    const fallback = vi.fn(() => {
      const source = Readable.from([Buffer.from("fresh")]); sources.push(source); return source;
    });
    const cache = createWorkFolderReadCache(entries, load, fallback);
    await consume(cache.read(entries[0]!));
    const lazy = cache.read(entries[1]!);
    cache.clear();
    expect(await consume(lazy)).toEqual(Buffer.from("fresh"));
    expect(await consume(cache.read(entries[2]!))).toEqual(Buffer.from("fresh"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(2);
    expect(sources.every((source) => source.destroyed)).toBe(true);
  });

  it("does not repopulate the cache after clearing an in-flight load", async () => {
    const entries = [entry("a"), entry("b")];
    let release!: (value: Buffer[]) => void;
    const load = vi.fn(() => new Promise<Buffer[]>((resolve) => { release = resolve; }));
    const fallback = vi.fn(() => Readable.from([Buffer.from("fresh")]));
    const cache = createWorkFolderReadCache(entries, load, fallback);
    const active = consume(cache.read(entries[0]!));
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    cache.clear(); release(bytes(entries));
    expect(await active).toEqual(Buffer.from("x"));
    expect(await consume(cache.read(entries[1]!))).toEqual(Buffer.from("fresh"));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([{ buffers: [] }, { buffers: [Buffer.alloc(2)] }])("rejects malformed batch contents and reopens the next attempt", async ({ buffers }) => {
    const item = entry("a");
    const load = vi.fn(async () => buffers);
    const fallback = vi.fn(() => Readable.from([Buffer.from("fresh")]));
    const cache = createWorkFolderReadCache([item], load, fallback);
    await expect(consume(cache.read(item))).rejects.toThrow("does not match its entries");
    expect(await consume(cache.read(item))).toEqual(Buffer.from("fresh"));
    cache.clear();
  });
});
