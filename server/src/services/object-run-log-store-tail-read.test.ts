import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { clearObjectJournalReadCache, objectJournalReadCacheBytes } from "./object-byte-journal.js";
import { createObjectRunLogStore } from "./object-run-log-store.js";

// A live run flushes its log in many small segments, so the task page's tail
// read (the last 32 KB, aligned to a record) crosses many objects. Each object
// GET costs a storage round trip, so the number of GETs that must run one after
// another decides how long the chat waits for the run's latest output.
function countingStorage(getLatencyMs: number | ((objectKey: string) => number) = 0) {
  const objects = new Map<string, Buffer>();
  const stats = { gets: 0, inFlight: 0, maxInFlight: 0, completed: 0 };
  const etag = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const provider: StorageProvider = {
    id: "s3",
    async putObject() {
      throw new Error("unconditional PUT forbidden");
    },
    async putObjectConditional(input) {
      const old = objects.get(input.objectKey);
      if (input.ifNoneMatch ? old : !old || etag(old) !== input.ifMatch)
        throw Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      objects.set(input.objectKey, bytes);
      return { etag: etag(bytes) };
    },
    async getObject({ objectKey }) {
      stats.gets++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      try {
        await delay(typeof getLatencyMs === "number" ? getLatencyMs : getLatencyMs(objectKey));
        const bytes = objects.get(objectKey);
        if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
        return { stream: Readable.from([bytes]), etag: etag(bytes), contentLength: bytes.length };
      } finally {
        stats.inFlight--;
        stats.completed++;
      }
    },
    async headObject({ objectKey }) {
      return { exists: objects.has(objectKey) };
    },
    async deleteObject({ objectKey }) {
      objects.delete(objectKey);
    },
    async listObjects({ prefix }) {
      return { keys: [...objects.keys()].filter((key) => key.startsWith(prefix)) };
    },
  };
  return { provider, stats, objects };
}

// Holds every content-addressed object GET until released; the head answers.
function holdObjectGets(provider: StorageProvider) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const gate = { keys: [] as string[], signals: [] as Array<AbortSignal | undefined>, headReads: 0, release: () => release() };
  const getObject = provider.getObject.bind(provider);
  provider.getObject = async (input) => {
    if (input.objectKey.includes("/objects/")) {
      gate.keys.push(input.objectKey);
      gate.signals.push(input.signal);
      await held;
    }
    const result = await getObject(input);
    if (input.objectKey.endsWith("/head.json")) gate.headReads++;
    return result;
  };
  return gate;
}

const TAIL_BYTES = 32_000;

async function writeManySegmentLog(
  provider: StorageProvider,
  records: number,
  chunk = (seq: number) => `line ${seq} ${"x".repeat(240)}\n`,
) {
  const store = createObjectRunLogStore({
    provider,
    keyPrefix: "logs",
    assertWriterAuthority: async () => undefined,
  });
  const handle = await store.begin({ companyId: "company", agentId: "agent", runId: "run" });
  for (let seq = 1; seq <= records; seq++) {
    // One append is one flushed segment, like a live run's frequent flushes.
    void store.enqueue!(handle, {
      stream: "stdout",
      chunk: chunk(seq),
      ts: "2026-11-09T00:00:00Z",
      seq,
    });
    await store.flush!(handle);
  }
  const full = Buffer.from((await store.read(handle)).content);
  return { store, handle, full };
}

describe("object run log tail reads", () => {
  it("reads an aligned tail across many segments in parallel and without a second traversal", async () => {
    clearObjectJournalReadCache();
    const { provider, stats } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 400);
    const offset = full.length - TAIL_BYTES;
    clearObjectJournalReadCache();
    stats.gets = 0;
    stats.maxInFlight = 0;

    const tail = await store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });

    // Correctness: the tail starts at the first complete record before offset.
    const recordStart = full.lastIndexOf(10, offset - 1) + 1;
    expect(Buffer.from(tail.content)).toEqual(full.subarray(recordStart));
    expect(tail.nextOffset).toBe(full.length);
    // Every object in the aligned range is fetched once, and fetches overlap.
    const singlePassGets = stats.gets;
    expect(stats.maxInFlight).toBeGreaterThan(1);

    clearObjectJournalReadCache();
    stats.gets = 0;
    const unaligned = await store.read(handle, { offset, limitBytes: TAIL_BYTES });
    expect(Buffer.from(unaligned.content)).toEqual(full.subarray(offset));
    // Alignment adds only a short record prefix, not a second walk of the index.
    expect(singlePassGets).toBeLessThanOrEqual(stats.gets + 30);
  });

  it("serves a repeated tail read from immutable objects without fetching them again", async () => {
    clearObjectJournalReadCache();
    const { provider, stats } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 200);
    const offset = full.length - TAIL_BYTES;
    const first = await store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });
    stats.gets = 0;

    const second = await store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });

    expect(second).toEqual(first);
    // Only the mutable head is read again; segments and index nodes are
    // content-addressed by their SHA-256, so they cannot change.
    expect(stats.gets).toBe(1);
  });

  it("keeps appended output visible to a tail read after earlier reads were cached", async () => {
    clearObjectJournalReadCache();
    const { provider } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 50);
    await store.read(handle, { offset: Math.max(0, full.length - TAIL_BYTES), limitBytes: TAIL_BYTES, alignStartToRecord: true });
    void store.enqueue!(handle, { stream: "stdout", chunk: "newest line\n", ts: "2026-11-09T00:00:01Z", seq: 51 });
    await store.flush!(handle);

    const tail = await store.read(handle, { offset: full.length - 300, limitBytes: TAIL_BYTES, alignStartToRecord: true });

    expect(tail.content).toContain("newest line");
  });

  it("stops a reader that navigates away while it waits on another reader's fetch", async () => {
    clearObjectJournalReadCache();
    const { provider } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 60);
    clearObjectJournalReadCache();
    const gets = holdObjectGets(provider);
    const offset = full.length - TAIL_BYTES / 2;
    const leaving = new AbortController();

    const staying = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });
    await vi.waitFor(() => expect(gets.keys.length).toBeGreaterThan(0));
    const joining = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true, signal: leaving.signal });
    // Let the joining reader read the head and reach the held shared fetch.
    await vi.waitFor(() => expect(gets.headReads).toBe(2));
    await new Promise((resolve) => setImmediate(resolve));
    leaving.abort(new Error("navigated away"));

    // Every object GET is still held, so only the reader's own abort can end it.
    await expect(joining).rejects.toThrow("navigated away");
    expect(gets.signals.every((signal) => !signal?.aborted)).toBe(true);
    gets.release();
    const tail = await staying;
    const recordStart = full.lastIndexOf(10, offset - 1) + 1;
    expect(Buffer.from(tail.content)).toEqual(full.subarray(recordStart));
    expect(new Set(gets.keys).size).toBe(gets.keys.length);
  });

  it("keeps one fetch per object when the reader that started it navigates away", async () => {
    clearObjectJournalReadCache();
    const { provider } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 60);
    clearObjectJournalReadCache();
    const gets = holdObjectGets(provider);
    const offset = full.length - TAIL_BYTES / 2;
    const leaving = new AbortController();

    const first = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true, signal: leaving.signal });
    await vi.waitFor(() => expect(gets.keys.length).toBeGreaterThan(0));
    const joining = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });
    // Let the joining reader read the head and reach the held shared fetch.
    await vi.waitFor(() => expect(gets.headReads).toBe(2));
    await new Promise((resolve) => setImmediate(resolve));
    leaving.abort(new Error("navigated away"));
    await expect(first).rejects.toThrow("navigated away");
    // The remaining reader still waits on the started fetch, so it stays open.
    expect(gets.signals.every((signal) => !signal?.aborted)).toBe(true);
    gets.release();

    const tail = await joining;
    const recordStart = full.lastIndexOf(10, offset - 1) + 1;
    expect(Buffer.from(tail.content)).toEqual(full.subarray(recordStart));
    // No object was fetched twice: the joining reader did not start its own GET.
    expect(new Set(gets.keys).size).toBe(gets.keys.length);
  });

  it("stops a shared fetch when its last reader navigates away", async () => {
    clearObjectJournalReadCache();
    const { provider } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 20);
    clearObjectJournalReadCache();
    const gets = holdObjectGets(provider);
    const leaving = new AbortController();

    const read = store.read(handle, { offset: Math.max(0, full.length - TAIL_BYTES), limitBytes: TAIL_BYTES, signal: leaving.signal });
    await vi.waitFor(() => expect(gets.keys.length).toBeGreaterThan(0));
    leaving.abort(new Error("navigated away"));

    await expect(read).rejects.toThrow("navigated away");
    expect(gets.signals[0]?.aborted).toBe(true);
    gets.release();
  });

  it.each([
    ["just over the first lookback window", 6_000],
    ["across several backward windows", 90_000],
  ])("aligns a tail that starts inside a record %s", async (_label, recordBytes) => {
    clearObjectJournalReadCache();
    const { provider } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 6, (seq) =>
      seq === 5 ? `long ${"y".repeat(recordBytes)}\n` : `line ${seq}\n`);
    const longStart = full.indexOf("long ");
    const longEnd = full.indexOf(10, longStart);
    // Start near the end of the long record, so the 4 KB lookback has no newline.
    const offset = longEnd - 100;
    expect(offset - longStart).toBeGreaterThan(4096);
    const recordStart = full.lastIndexOf(10, offset - 1) + 1;
    clearObjectJournalReadCache();

    const tail = await store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });

    expect(Buffer.from(tail.content)).toEqual(full.subarray(recordStart));
    expect(tail.nextOffset).toBe(full.length);
  });

  it("counts per-entry overhead against the cache budget, not only the object bytes", async () => {
    clearObjectJournalReadCache();
    const { provider, objects } = countingStorage();
    const { store, handle, full } = await writeManySegmentLog(provider, 100);
    clearObjectJournalReadCache();
    const gets = holdObjectGets(provider);
    gets.release();

    await store.read(handle, { offset: Math.max(0, full.length - TAIL_BYTES), limitBytes: TAIL_BYTES });

    const cached = [...new Set(gets.keys)];
    const payload = cached.reduce((sum, key) => sum + objects.get(key)!.length, 0);
    // Many small segments: the bookkeeping per entry is a real part of memory.
    expect(objectJournalReadCacheBytes()).toBeGreaterThanOrEqual(payload + cached.length * 256);
    clearObjectJournalReadCache();
    expect(objectJournalReadCacheBytes()).toBe(0);
  });

  it("does not serve one store's cached objects to a reader of another store", async () => {
    clearObjectJournalReadCache();
    const first = countingStorage();
    const { handle, full } = await writeManySegmentLog(first.provider, 20);
    const offset = Math.max(0, full.length - TAIL_BYTES);
    // A second store has the same head, but none of the objects.
    const second = countingStorage();
    for (const [key, bytes] of first.objects) if (!key.includes("/objects/")) second.objects.set(key, bytes);
    const secondStore = createObjectRunLogStore({ provider: second.provider, keyPrefix: "logs", assertWriterAuthority: async () => undefined });

    await expect(secondStore.read(handle, { offset, limitBytes: TAIL_BYTES })).rejects.toThrow();
    expect(second.stats.gets).toBeGreaterThan(1);
  });
});
