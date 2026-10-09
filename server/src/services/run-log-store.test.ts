import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
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
      // Real S3 answers 416 when the range starts at or past EOF — the mock
      // must too, or caught-up-reader regressions (PAPERCLIP-BACKEND-9) pass
      // silently with an empty slice.
      if (input.range && (input.range.start >= buf.length || input.range.start > input.range.end)) {
        const err = new Error("Invalid range") as Error & { name: string };
        err.name = "InvalidRange";
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

  it.each([false, true])("retains every attempt across retry (pod restart: %s)", async (restart) => {
    const { provider, objects } = createMemoryProvider();
    let store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const attempts: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (restart && attempt > 1) {
        await fs.rm(baseDir, { recursive: true, force: true });
        store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
      }
      const handle = await store.begin(begin);
      attempts.push(handle.attemptId!);
      await store.append(handle, { stream: "stderr", chunk: `attempt-${attempt}`, ts: "same-time", seq: attempt });
      const summary = await store.finalize(handle);
      const saved = objects.get(handle.logRef)!;
      const lines = saved.toString().trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.map((line) => line.chunk)).toEqual(Array.from({length: attempt}, (_, i) => `attempt-${i + 1}`));
      expect(lines.map((line) => line.attemptId)).toEqual(attempts);
      expect(new Set(attempts).size).toBe(attempt);
      expect(summary.bytes).toBe(saved.length);
      expect(summary.sha256).toBe(createHash("sha256").update(saved).digest("hex"));
    }
  });

  it("never replaces concurrent appends when two stores restore the same missing log", async () => {
    const { provider, objects } = createMemoryProvider();
    const firstStore = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const secondStore = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const original = await firstStore.begin(begin);
    await firstStore.append(original, { stream: "stderr", chunk: "original", ts: "t0" });
    await firstStore.finalize(original);
    const prefix = Buffer.from(objects.get(original.logRef)!);
    await fs.rm(baseDir, { recursive: true, force: true });
    let reached!: () => void, release!: () => void;
    const restoring = new Promise<void>((resolve) => { reached = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(provider, "getObject").mockImplementationOnce(async () => ({
      stream: Readable.from((async function* () {
        yield prefix;
        reached();
        await barrier;
      })()),
      contentLength: prefix.length,
    }));
    const slow = firstStore.begin(begin);
    try {
      await restoring;
      const fast = await secondStore.begin(begin);
      await secondStore.append(fast, { stream: "stderr", chunk: "fast attempt", ts: "t1" });
      release();
      const late = await slow;
      await firstStore.append(late, { stream: "stderr", chunk: "slow attempt", ts: "t2" });
      await firstStore.finalize(late);
      const saved = objects.get(original.logRef)!;
      expect(saved).toEqual(await fs.readFile(path.join(baseDir, original.logRef)));
      expect(saved.toString().trim().split("\n").map((line) => JSON.parse(line).chunk))
        .toEqual(["original", "fast attempt", "slow attempt"]);
    } finally {
      release();
      await slow.catch(() => undefined);
      spy.mockRestore();
    }
  });

  it.each(["stream_failure", "short_read"])("preserves the durable prefix when restore fails (%s)", async (fault) => {
    const { provider, objects, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stderr", chunk: "original failure evidence", ts: "t1" });
    await store.finalize(handle);
    const prefix = Buffer.from(objects.get(handle.logRef)!);
    await fs.rm(baseDir, { recursive: true, force: true });
    const spy = vi.spyOn(provider, "getObject").mockResolvedValueOnce({
      stream: Readable.from((async function* () {
        yield prefix.subarray(0, 10);
        if (fault === "stream_failure") throw new Error("storage connection lost");
      })()),
      contentLength: prefix.length,
    });
    try {
      await expect(store.begin(begin)).rejects.toThrow(
        fault === "stream_failure" ? "storage connection lost" : "incomplete prefix",
      );
      await expect(fs.stat(path.join(baseDir, handle.logRef))).rejects.toMatchObject({ code: "ENOENT" });
      expect(objects.get(handle.logRef)).toEqual(prefix);
      expect(calls.put).toBe(1);
      const next = await store.begin(begin);
      expect(await fs.readFile(path.join(baseDir, next.logRef))).toEqual(prefix);
    } finally { spy.mockRestore(); }
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

  it.each(["finishes", "fails"])("waits for an accepted file append that %s before finalizing", async (outcome) => {
    const { provider, objects } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const appendFile = fs.appendFile.bind(fs);
    const spy = vi.spyOn(fs, "appendFile").mockImplementationOnce(async (...args) => {
      await gate;
      if (outcome === "fails") throw new Error("disk unavailable");
      await appendFile(...args);
    });
    const append = store.append(handle, { stream: "stderr", chunk: "late diagnostic", ts: "t1" });
    // Observe the deliberate rejection independently of finalization.
    void append.catch(() => {});
    let finalized = false;
    const finalize = store.finalize(handle).then((summary) => {
      finalized = true;
      return summary;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(finalized).toBe(false);
      release();
      if (outcome === "fails") await expect(append).rejects.toThrow("disk unavailable");
      else await append;
      const summary = await finalize;
      const local = await fs.readFile(path.join(baseDir, handle.logRef));
      expect(summary.bytes).toBe(local.length);
      expect(summary.sha256).toBe(createHash("sha256").update(local).digest("hex"));
      expect(objects.get(handle.logRef)).toEqual(local);
      expect(local.toString()).toBe(outcome === "fails" ? "" : JSON.stringify({
        ts: "t1", attemptId: handle.attemptId, stream: "stderr", chunk: "late diagnostic",
      }) + "\n");
    } finally {
      release();
      await append.catch(() => {});
      await finalize;
      spy.mockRestore();
    }
  });

  it("ignores appends once finalization starts so the durable snapshot stays immutable", async () => {
    const { provider, objects } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "accepted", ts: "t1" });
    const finalize = store.finalize(handle);
    expect(await store.append(handle, { stream: "stderr", chunk: "too late", ts: "t2" })).toBe(0);
    const summary = await finalize;
    expect(await store.append(handle, { stream: "stderr", chunk: "also too late", ts: "t3" })).toBe(0);
    const local = await fs.readFile(path.join(baseDir, handle.logRef));
    expect(local.toString()).not.toContain("too late");
    expect(summary.bytes).toBe(local.length);
    expect(summary.sha256).toBe(createHash("sha256").update(local).digest("hex"));
    expect(objects.get(handle.logRef)).toEqual(local);
  });

  it("leaves final metadata unknown when an append stalls and never mirrors its late completion", async () => {
    const { provider, calls } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, inflightMirrorMs: 10_000 } });
    const handle = await store.begin(begin);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const appendFile = fs.appendFile.bind(fs);
    const spy = vi.spyOn(fs, "appendFile").mockImplementationOnce(async (...args) => {
      await gate;
      await appendFile(...args);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const append = store.append(handle, { stream: "stderr", chunk: "stalled diagnostic", ts: "t1" });
    let summary: Awaited<ReturnType<typeof store.finalize>> | undefined;
    const finalize = store.finalize(handle).then((result) => { summary = result; });
    try {
      await vi.advanceTimersByTimeAsync(3_000);
      expect(summary).toEqual({ bytes: null, sha256: null, compressed: false });
      expect(warn).toHaveBeenCalled();
      expect(calls.put).toBe(0);
      release();
      await append;
      await vi.advanceTimersByTimeAsync(20_000);
      await store.flushInflightMirrors!();
      expect(calls.put).toBe(0);
      expect(await store.finalize(handle)).toEqual(summary);
      expect(await store.append(handle, { stream: "stderr", chunk: "too late", ts: "t2" })).toBe(0);
    } finally {
      release();
      await append;
      await finalize;
      vi.useRealTimers();
      spy.mockRestore();
      warn.mockRestore();
    }
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

  it("S3 fallback returns an empty read (no InvalidRange) when the reader is fully caught up", async () => {
    // Regression test for PAPERCLIP-BACKEND-9: a poller that had consumed the
    // whole log kept polling at offset === total after the pod rolled; the S3
    // path clamped end up to start and requested `bytes=total-total`, which
    // S3 rejects with 416 InvalidRange -> 500.
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider, keyPrefix: "p" } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "0123456789", ts: "t" });
    await store.finalize(handle);
    const full = await store.read(handle);
    const total = Buffer.byteLength(full.content, "utf8");
    await fs.rm(baseDir, { recursive: true, force: true }); // force S3 path
    const caughtUp = await store.read(handle, { offset: total, limitBytes: 100 });
    expect(caughtUp.content).toBe("");
    expect(caughtUp.nextOffset).toBeUndefined();
    // Past-EOF offsets clamp to the same empty read.
    const pastEof = await store.read(handle, { offset: total + 50, limitBytes: 100 });
    expect(pastEof.content).toBe("");
    expect(pastEof.nextOffset).toBeUndefined();
  });

  it("local read at offset === size returns an empty read with undefined nextOffset", async () => {
    const store = createDurableRunLogStore({ basePath: baseDir });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "abc", ts: "t" });
    const full = await store.read(handle);
    const total = Buffer.byteLength(full.content, "utf8");
    const caughtUp = await store.read(handle, { offset: total, limitBytes: 100 });
    expect(caughtUp.content).toBe("");
    expect(caughtUp.nextOffset).toBeUndefined();
  });

  it("reads local pages without waiting for a separate metadata request", async () => {
    const store = createDurableRunLogStore({ basePath: baseDir });
    const handle = await store.begin(begin);
    await fs.writeFile(path.join(baseDir, handle.logRef), "0123456789");
    const statSpy = vi.spyOn(fs, "stat").mockRejectedValue(new Error("Metadata unavailable"));
    try {
      expect(await store.read(handle, { offset: 2, limitBytes: 4 })).toEqual({ content: "2345", nextOffset: 6 });
      expect(await store.read(handle, { offset: 6, limitBytes: 4 })).toEqual({ content: "6789", nextOffset: undefined });
      expect(await store.read(handle, { offset: 20, limitBytes: 4 })).toEqual({ content: "", nextOffset: undefined });
    } finally {
      statSpy.mockRestore();
    }
  });

  it.each([false, true])("masks a historical PostgreSQL URL across byte-range pages (S3: %s)", async (fromS3) => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    const url = "postgresql://etl_user:p%40ss%3Aword@db.example.test/app";
    await store.append(handle, { stream: "stdout", chunk: `ps --dbname=${url} complete`, ts: "t" });
    const raw = await store.read(handle);
    if (fromS3) {
      await store.finalize(handle);
      await fs.rm(path.join(baseDir, handle.logRef));
    }
    let content = "";
    for (let offset = 0; offset < Buffer.byteLength(raw.content); offset += 7) {
      const page = await store.read(handle, { offset, limitBytes: 7, redactPostgresCredentials: true });
      content += page.content;
      expect(page.nextOffset).toBe(offset + 7 < Buffer.byteLength(raw.content) ? offset + 7 : undefined);
      expect(page.content).not.toContain("etl_user");
    }
    expect(content).toMatch(/postgresql:\/\/\*+@db\.example\.test\/app/);
    expect(content).toContain("complete");
    expect(content).not.toContain("etl_user");
    expect(content).not.toContain("p%40ss%3Aword");
    expect(await store.read(handle, {
      offset: 300_000,
      limitBytes: 7,
      redactPostgresCredentials: true,
    })).toEqual({ content: "", nextOffset: undefined });
    expect((await store.read(handle)).content).toBe(raw.content);
  });

  it.each([false, true])("masks historical userinfo split across NDJSON records (S3: %s)", async (fromS3) => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    await store.append(handle, { stream: "stdout", chunk: "ps --dbname=postgres://worker:pa", ts: "t1" });
    await store.append(handle, { stream: "stderr", chunk: "ordinary diagnostic", ts: "t2" });
    await store.append(handle, { stream: "stdout", chunk: "'ss%40", ts: "t3" });
    await store.append(handle, { stream: "stdout", chunk: "word@db.example.test/app done", ts: "t4" });
    const raw = await store.read(handle);
    if (fromS3) {
      await store.finalize(handle);
      await fs.rm(path.join(baseDir, handle.logRef));
    }
    const redacted = await store.read(handle, { limitBytes: 4096, redactPostgresCredentials: true });
    const records = redacted.content.trim().split("\n").map((line) => JSON.parse(line) as { stream: string; chunk: string });
    const stdout = records.filter((record) => record.stream === "stdout").map((record) => record.chunk).join("");
    expect(stdout).toMatch(/postgres:\/\/\*+@db\.example\.test\/app done/);
    expect(stdout).not.toContain("worker");
    expect(stdout).not.toContain("pa'ss%40word");
    expect(records.find((record) => record.stream === "stderr")?.chunk).toBe("ordinary diagnostic");
    const pageOffset = raw.content.indexOf("ss%40");
    expect(pageOffset).toBeGreaterThan(0);
    expect(await store.read(handle, { offset: pageOffset, limitBytes: 5, redactPostgresCredentials: true }))
      .toEqual({ content: "*****", nextOffset: pageOffset + 5 });
  });

  it.each([false, true])("masks historical userinfo cut by a run-log truncation marker (S3: %s)", async (fromS3) => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    const marker = "\n[paperclip truncated run log chunk: omitted 100 chars]\n";
    await store.append(handle, {
      stream: "stdout",
      chunk: `ps --dbname=postgresql://worker:p%40ss${marker}diagnostic tail`,
      ts: "t1",
    });
    const raw = await store.read(handle);
    if (fromS3) {
      await store.finalize(handle);
      await fs.rm(path.join(baseDir, handle.logRef));
    }
    let content = "";
    for (let offset = 0; offset < Buffer.byteLength(raw.content); offset += 9) {
      const page = await store.read(handle, { offset, limitBytes: 9, redactPostgresCredentials: true });
      content += page.content;
      expect(page.nextOffset).toBe(offset + 9 < Buffer.byteLength(raw.content) ? offset + 9 : undefined);
    }
    expect(content).toMatch(/postgresql:\/\/\*+\\n\[paperclip truncated run log chunk:/);
    expect(content).toContain("diagnostic tail");
    expect(content).not.toContain("worker");
    expect(content).not.toContain("p%40ss");
    expect((await store.read(handle)).content).toBe(raw.content);
  });

  it("masks credentials longer than the bounded read context", async () => {
    const store = createDurableRunLogStore({ basePath: baseDir });
    const handle = await store.begin(begin);
    const password = "x".repeat(300_000);
    await store.append(handle, {
      stream: "stdout",
      chunk: `postgres://user:${password}@db.example.test/app`,
      ts: "t",
    });
    const raw = await store.read(handle);
    const schemeOffset = raw.content.indexOf("postgres://");
    const middleOffset = raw.content.indexOf(password) + 280_000;
    const start = await store.read(handle, {
      offset: schemeOffset,
      limitBytes: 32,
      redactPostgresCredentials: true,
    });
    const middle = await store.read(handle, {
      offset: middleOffset,
      limitBytes: 32,
      redactPostgresCredentials: true,
    });
    // The oversized record cannot be classified within the bounded read, so
    // even its otherwise diagnostic scheme is hidden on this page.
    expect(start.content).toBe("*".repeat(32));
    expect(middle.content).toBe("*".repeat(32));
    expect(middle.nextOffset).toBe(middleOffset + 32);
  });

  it.each([false, true])("fails closed inside an oversized historical record (S3: %s)", async (fromS3) => {
    const { provider } = createMemoryProvider();
    const store = createDurableRunLogStore({ basePath: baseDir, s3: { provider } });
    const handle = await store.begin(begin);
    // 50,000 control characters expand beyond the 256 KiB lookbehind when
    // encoded in NDJSON. The URL authority finishes in the following record.
    await store.append(handle, {
      stream: "stdout",
      chunk: `${"\u0001".repeat(50_000)}postgres://worker:partial`,
      ts: "t1",
    });
    await store.append(handle, {
      stream: "stdout",
      chunk: "secret@db.example.test/app done",
      ts: "t2",
    });
    const raw = await store.read(handle, { limitBytes: 400_000 });
    if (fromS3) {
      await store.finalize(handle);
      await fs.rm(path.join(baseDir, handle.logRef));
    }
    for (const fragment of ["partial", "secret"]) {
      const offset = raw.content.indexOf(fragment) + 2;
      expect(offset).toBeGreaterThan(2);
      const page = await store.read(handle, {
        offset,
        limitBytes: 4,
        redactPostgresCredentials: true,
      });
      expect(page.content).toBe("****");
      expect(page.nextOffset).toBe(offset + 4);
    }
    expect((await store.read(handle, { limitBytes: 400_000 })).content).toBe(raw.content);
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
