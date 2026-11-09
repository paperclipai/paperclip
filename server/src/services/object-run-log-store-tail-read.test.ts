import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { clearObjectJournalReadCache } from "./object-byte-journal.js";
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
  return { provider, stats };
}

const TAIL_BYTES = 32_000;

async function writeManySegmentLog(provider: StorageProvider, records: number) {
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
      chunk: `line ${seq} ${"x".repeat(240)}\n`,
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

  it("finishes a reader that shares an object fetch with a reader who navigated away", async () => {
    clearObjectJournalReadCache();
    const { provider } = countingStorage(5);
    const { store, handle, full } = await writeManySegmentLog(provider, 60);
    clearObjectJournalReadCache();
    const offset = full.length - TAIL_BYTES / 2;
    const leaving = new AbortController();

    const abandoned = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true, signal: leaving.signal });
    const staying = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });
    setTimeout(() => leaving.abort(new Error("navigated away")), 8);

    await expect(abandoned).rejects.toThrow();
    const tail = await staying;
    const recordStart = full.lastIndexOf(10, offset - 1) + 1;
    expect(Buffer.from(tail.content)).toEqual(full.subarray(recordStart));
  });

  it("stops a reader that navigates away while it waits on another reader's fetch", async () => {
    clearObjectJournalReadCache();
    // Content-addressed objects (segments and index nodes) are slow; the
    // mutable head is fast, so the second reader joins the first one's fetch.
    const { provider, stats } = countingStorage((key) => (/[0-9a-f]{64}/.test(key) ? 60 : 0));
    const { store, handle, full } = await writeManySegmentLog(provider, 60);
    clearObjectJournalReadCache();
    const offset = full.length - TAIL_BYTES / 2;
    const leaving = new AbortController();

    const staying = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true });
    await delay(10);
    const completedBeforeJoin = stats.completed;
    let completedWhenAborted = -1;
    const joining = store.read(handle, { offset, limitBytes: TAIL_BYTES, alignStartToRecord: true, signal: leaving.signal })
      .catch((error: unknown) => { completedWhenAborted = stats.completed; throw error; });
    setTimeout(() => leaving.abort(new Error("navigated away")), 10);

    await expect(joining).rejects.toThrow("navigated away");
    // The joining reader stops on its own abort. It does not wait for the
    // shared fetch: only the fast head read finished since it joined.
    expect(completedWhenAborted - completedBeforeJoin).toBeLessThanOrEqual(1);
    const tail = await staying;
    const recordStart = full.lastIndexOf(10, offset - 1) + 1;
    expect(Buffer.from(tail.content)).toEqual(full.subarray(recordStart));
  });
});
