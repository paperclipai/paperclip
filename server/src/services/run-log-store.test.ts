import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { createDurableRunLogStore } from "./run-log-store.js";
import type { StorageProvider } from "../storage/types.js";

// In-memory StorageProvider stand-in: durable, survives the "pod roll" (local
// dir wipe) the same way Cubbit does. Records calls so we can assert behaviour.
function createMemoryProvider() {
  const objects = new Map<string, Buffer>();
  const calls = { put: 0, get: 0, head: 0 };
  const provider: StorageProvider = {
    id: "s3",
    async putObject(input) {
      calls.put++;
      if (Buffer.isBuffer(input.body)) {
        objects.set(input.objectKey, Buffer.from(input.body));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      objects.set(input.objectKey, Buffer.concat(chunks));
    },
    async getObject(input) {
      calls.get++;
      const buf = objects.get(input.objectKey);
      if (!buf) {
        const err = new Error("Object not found") as Error & { name: string };
        err.name = "NoSuchKey";
        throw err;
      }
      const slice = input.range ? buf.subarray(input.range.start, input.range.end + 1) : buf;
      return { stream: Readable.from(slice), contentLength: slice.length };
    },
    async headObject(input) {
      calls.head++;
      const buf = objects.get(input.objectKey);
      return buf ? { exists: true, contentLength: buf.length } : { exists: false };
    },
    async deleteObject(input) {
      objects.delete(input.objectKey);
    },
  };
  return { provider, objects, calls };
}

let baseDir: string;
beforeEach(async () => {
  baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-store-test-"));
});
afterEach(async () => {
  await fs.rm(baseDir, { recursive: true, force: true });
});

const begin = { companyId: "co1", agentId: "ag1", runId: "run1" };

describe("createDurableRunLogStore", () => {
  it("keeps store id 'local_file' so downstream coupling (feedback, casts) is unchanged", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    expect(handle.store).toBe("local_file");
  });

  it("appends locally and reads back during a run WITHOUT hitting S3 (fast live tail)", async () => {
    const { provider, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "hello", ts: "t1" });
    const res = await store.read(handle);
    expect(res.content).toContain("hello");
    expect(calls.get).toBe(0); // local file present -> no S3 read
  });

  it("uploads the complete log to S3 on finalize", async () => {
    const { provider, objects, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "run-logs" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "line-A", ts: "t1" });
    await store.append(handle, { stream: "stdout", chunk: "line-B", ts: "t2" });
    const summary = await store.finalize(handle);
    expect(calls.put).toBe(1);
    expect(summary.bytes).toBeGreaterThan(0);
    // keyed by prefix + the handle's logRef so read can find it later
    const key = `run-logs/${handle.logRef}`;
    expect(objects.has(key)).toBe(true);
    expect(objects.get(key)!.toString("utf8")).toContain("line-A");
    expect(objects.get(key)!.toString("utf8")).toContain("line-B");
  });

  it("falls back to S3 when the local file is gone (the pod-roll case that caused 'Run log not found')", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "run-logs" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "persisted-line", ts: "t1" });
    await store.finalize(handle);
    // Simulate a pod restart wiping the emptyDir.
    await fs.rm(baseDir, { recursive: true, force: true });
    const res = await store.read(handle);
    expect(res.content).toContain("persisted-line");
  });

  it("S3 fallback honours offset/limitBytes (range read) and reports nextOffset", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "p" } });
    const handle = await store.begin(begin);
    // one line; persisted bytes = JSON line + "\n"
    await store.append(handle, { stream: "stdout", chunk: "0123456789", ts: "t" });
    await store.finalize(handle);
    const full = await store.read(handle); // from local, to learn total size
    const total = Buffer.byteLength(full.content, "utf8");
    await fs.rm(baseDir, { recursive: true, force: true }); // force S3 path
    const firstHalf = await store.read(handle, { offset: 0, limitBytes: 5 });
    expect(Buffer.byteLength(firstHalf.content, "utf8")).toBe(5);
    expect(firstHalf.nextOffset).toBe(5);
    const tail = await store.read(handle, { offset: total - 3, limitBytes: 100 });
    expect(Buffer.byteLength(tail.content, "utf8")).toBe(3);
    expect(tail.nextOffset).toBeUndefined();
  });

  it("falls back to S3 when the local file vanishes between stat() and open (TOCTOU race)", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "run-logs" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "raced-line", ts: "t1" });
    await store.finalize(handle);
    // Delete the local file DURING stat(), i.e. after it reports the file
    // present but before createReadStream opens it -> the open hits ENOENT.
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
      const result = await realStat(target as Parameters<typeof realStat>[0], ...(rest as []));
      if (String(target).endsWith(".ndjson")) {
        await fs.rm(target as string, { force: true });
      }
      return result;
    });
    try {
      const res = await store.read(handle);
      expect(res.content).toContain("raced-line");
    } finally {
      statSpy.mockRestore();
    }
  });

  it("throws notFound when neither local nor S3 has the log (pre-S3 run after a roll)", async () => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await fs.rm(baseDir, { recursive: true, force: true }); // never finalized -> never uploaded
    await expect(store.read(handle)).rejects.toThrow(/not found/i);
  });

  it("without S3 configured behaves exactly like the local-only store (safe degrade)", async () => {
    const store = createDurableRunLogStore({ basePath: baseDir });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "local-only", ts: "t1" });
    await store.finalize(handle);
    const res = await store.read(handle);
    expect(res.content).toContain("local-only");
    // and a roll loses it (documented limitation; this is the pre-fix behaviour)
    await fs.rm(baseDir, { recursive: true, force: true });
    await expect(store.read(handle)).rejects.toThrow(/not found/i);
  });
});

describe("in-flight mirror", () => {
  it("is OFF by default: appends never upload before finalize", async () => {
    const { provider, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "tail-1", ts: "t1" });
    await store.append(handle, { stream: "stdout", chunk: "tail-2", ts: "t2" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.put).toBe(0);
    // flush is a no-op with the mirror off
    await store.flushInflightMirrors?.();
    expect(calls.put).toBe(0);
  });

  it("mirrors the running log after the interval so a wipe without finalize preserves the tail", async () => {
    const { provider, objects } = createMemoryProvider();
    const store = createDurableRunLogStore({
      basePath: baseDir,
      s3: { provider, keyPrefix: "run-logs", inflightMirrorMs: 10 },
    });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "crash-tail", ts: "t1" });
    const key = `run-logs/${handle.logRef}`;
    await vi.waitFor(() => expect(objects.has(key)).toBe(true), { timeout: 2000 });
    // Simulate a crash mid-run: local dir wiped, run never finalized.
    await fs.rm(baseDir, { recursive: true, force: true });
    const res = await store.read(handle);
    expect(res.content).toContain("crash-tail");
  });

  it("throttles: rapid appends coalesce into one upload, delivered by flush", async () => {
    const { provider, objects, calls } = createMemoryProvider();
    // Interval far beyond the test's lifetime: nothing may upload until the
    // flush, and the flush must carry every appended line in ONE put.
    const store = createDurableRunLogStore({
      basePath: baseDir,
      s3: { provider, keyPrefix: "run-logs", inflightMirrorMs: 60_000 },
    });
    const handle = await store.begin(begin);
    for (let i = 0; i < 5; i++) {
      await store.append(handle, { stream: "stdout", chunk: `line-${i}`, ts: `t${i}` });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.put).toBe(0); // throttled: no per-append PUT
    await store.flushInflightMirrors?.();
    expect(calls.put).toBe(1);
    const body = objects.get(`run-logs/${handle.logRef}`)!.toString("utf8");
    for (let i = 0; i < 5; i++) expect(body).toContain(`line-${i}`);
    // Nothing dirty afterwards: flushing again uploads nothing.
    await store.flushInflightMirrors?.();
    expect(calls.put).toBe(1);
  });

  it("finalize supersedes the in-flight mirror and retires its timer", async () => {
    const { provider, objects, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({
      basePath: baseDir,
      s3: { provider, keyPrefix: "run-logs", inflightMirrorMs: 10 },
    });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "early-tail", ts: "t1" });
    const key = `run-logs/${handle.logRef}`;
    await vi.waitFor(() => expect(objects.has(key)).toBe(true), { timeout: 2000 });
    await store.append(handle, { stream: "stdout", chunk: "final-line", ts: "t2" });
    await store.finalize(handle);
    const body = objects.get(key)!.toString("utf8");
    expect(body).toContain("early-tail");
    expect(body).toContain("final-line");
    // No retired timer fires a stale partial upload over the finalized log.
    const putsAfterFinalize = calls.put;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(calls.put).toBe(putsAfterFinalize);
    expect(objects.get(key)!.toString("utf8")).toContain("final-line");
  });

  it("shutdown flush re-checks dirtiness after an upload already on the wire completes", async () => {
    const { provider, objects, calls } = createMemoryProvider();
    let releaseFirstPut: (() => void) | null = null;
    const firstPutGate = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let putStarts = 0;
    const realPut = provider.putObject.bind(provider);
    provider.putObject = async (input) => {
      putStarts++;
      if (putStarts === 1) await firstPutGate; // hold the first upload on the wire
      return realPut(input);
    };
    const store = createDurableRunLogStore({
      basePath: baseDir,
      s3: { provider, keyPrefix: "run-logs", inflightMirrorMs: 10 },
    });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "mirrored-line", ts: "t1" });
    await vi.waitFor(() => expect(putStarts).toBe(1), { timeout: 2000 });
    // Re-dirty the entry while the first upload is still in flight.
    await store.append(handle, { stream: "stdout", chunk: "tail-during-upload", ts: "t2" });
    const flush = store.flushInflightMirrors!();
    releaseFirstPut!();
    await flush;
    // A single-pass flush would exit after the first upload and leave the
    // tail on an unref'ed timer that never fires once the process exits.
    const body = objects.get(`run-logs/${handle.logRef}`)!.toString("utf8");
    expect(body).toContain("tail-during-upload");
    expect(calls.put).toBeGreaterThanOrEqual(2);
  });

  it("bounds the in-flight upload to the stat'ed size when appends race the stream", async () => {
    const { provider, objects } = createMemoryProvider();
    const store = createDurableRunLogStore({
      basePath: baseDir,
      s3: { provider, keyPrefix: "run-logs", inflightMirrorMs: 60_000 },
    });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "counted-line", ts: "t1" });
    const absPath = path.join(baseDir, handle.logRef);
    const sizeAtStat = (await fs.stat(absPath)).size;
    // Grow the file between the mirror's stat() and its stream reaching EOF:
    // the upload must carry exactly the stat'ed bytes, not the racing tail
    // (an unbounded stream would violate the declared contentLength).
    const realStat = fs.stat.bind(fs);
    const statSpy = vi.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
      const result = await realStat(target as Parameters<typeof realStat>[0], ...(rest as []));
      if (String(target).endsWith(".ndjson")) {
        await fs.appendFile(absPath, `${JSON.stringify({ ts: "t2", stream: "stdout", chunk: "raced-append" })}\n`);
      }
      return result;
    });
    try {
      await store.flushInflightMirrors!();
    } finally {
      statSpy.mockRestore();
    }
    const body = objects.get(`run-logs/${handle.logRef}`)!;
    expect(body.length).toBe(sizeAtStat);
    expect(body.toString("utf8")).toContain("counted-line");
    expect(body.toString("utf8")).not.toContain("raced-append");
  });

  it("in-flight upload failures never break appends and recover on the next flush", async () => {
    const { provider, objects, calls } = createMemoryProvider();
    let failPuts = true;
    const realPut = provider.putObject.bind(provider);
    provider.putObject = async (input) => {
      if (failPuts) throw new Error("endpoint down");
      return realPut(input);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const store = createDurableRunLogStore({
        basePath: baseDir,
        s3: { provider, keyPrefix: "run-logs", inflightMirrorMs: 60_000 },
      });
      const handle = await store.begin(begin);
      await store.append(handle, { stream: "stdout", chunk: "survives-outage", ts: "t1" });
      await store.flushInflightMirrors?.(); // upload fails, append flow unaffected
      expect(warn).toHaveBeenCalled();
      await store.append(handle, { stream: "stdout", chunk: "post-outage", ts: "t2" });
      failPuts = false;
      await store.flushInflightMirrors?.();
      const body = objects.get(`run-logs/${handle.logRef}`)!.toString("utf8");
      expect(body).toContain("survives-outage");
      expect(body).toContain("post-outage");
      expect(calls.put).toBe(1); // only the successful upload reached storage
    } finally {
      warn.mockRestore();
    }
  });
});
