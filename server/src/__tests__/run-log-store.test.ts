import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs, createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { createLocalFileRunLogStore, type RunLogHandle } from "../services/run-log-store.ts";

const COMPANY = "company-1";
const AGENT = "agent-1";
const RUN = "run-1";

let base: string;
const savedEnv = process.env.PAPERCLIP_RUN_LOG_COMPRESS;

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), "run-log-store-"));
  delete process.env.PAPERCLIP_RUN_LOG_COMPRESS;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.PAPERCLIP_RUN_LOG_COMPRESS;
  else process.env.PAPERCLIP_RUN_LOG_COMPRESS = savedEnv;
  await fs.rm(base, { recursive: true, force: true });
});

function storeAt(dir: string) {
  return createLocalFileRunLogStore(dir);
}

async function seedLines(store = storeAt(base), lineCount = 200): Promise<{ handle: RunLogHandle; raw: string }> {
  const handle = await store.begin({ companyId: COMPANY, agentId: AGENT, runId: RUN });
  let raw = "";
  for (let i = 0; i < lineCount; i += 1) {
    const before = raw.length;
    await store.append(handle, {
      stream: "stdout",
      chunk: `chunk number ${i} with some repetitive streaming delta payload payload payload`,
      ts: new Date(1_700_000_000_000 + i).toISOString(),
    });
    // Reconstruct exactly what append persisted so `raw` mirrors the file.
    const line = JSON.stringify({
      ts: new Date(1_700_000_000_000 + i).toISOString(),
      stream: "stdout",
      chunk: `chunk number ${i} with some repetitive streaming delta payload payload payload`,
    });
    raw += `${line}\n`;
    void before;
  }
  return { handle, raw };
}

/** Read the raw ndjson straight from disk (independent of the store's read path). */
async function readRawFromDisk(logRef: string): Promise<string> {
  const abs = path.resolve(base, logRef);
  if (abs.endsWith(".gz")) {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const s = createReadStream(abs).pipe(createGunzip());
      s.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      s.on("error", reject);
      s.on("end", () => resolve());
    });
    return Buffer.concat(chunks).toString("utf8");
  }
  return fs.readFile(abs, "utf8");
}

/** Drain the full log via the store's paginated read, chaining nextOffset. */
async function readAllPaginated(
  store: ReturnType<typeof storeAt>,
  handle: RunLogHandle,
  limitBytes: number,
): Promise<string> {
  let out = "";
  let offset: number | undefined = 0;
  // Guard against infinite loops.
  for (let i = 0; i < 100_000; i += 1) {
    const res = await store.read(handle, { offset, limitBytes });
    out += res.content;
    if (res.nextOffset == null) break;
    expect(res.nextOffset).toBe(offset! + Buffer.byteLength(res.content, "utf8"));
    offset = res.nextOffset;
  }
  return out;
}

describe("run-log-store compression", () => {
  it("reads a live (un-finalized) run as plain ndjson", async () => {
    const store = storeAt(base);
    const { handle, raw } = await seedLines(store, 20);
    const res = await store.read(handle, { offset: 0, limitBytes: 10_000_000 });
    expect(res.content).toBe(raw);
    expect(res.nextOffset).toBeUndefined();
    // File still exists as raw ndjson.
    await expect(fs.stat(path.resolve(base, handle.logRef))).resolves.toBeTruthy();
  });

  it("finalize compresses: .gz exists, raw gone, summary is correct", async () => {
    const store = storeAt(base);
    const { handle, raw } = await seedLines(store, 200);
    const rawBytes = Buffer.byteLength(raw, "utf8");

    const summary = await store.finalize(handle);

    expect(summary.compressed).toBe(true);
    expect(summary.bytes).toBe(rawBytes);
    expect(summary.logRef.endsWith(".ndjson.gz")).toBe(true);
    expect(summary.logRef).toBe(`${handle.logRef}.gz`);

    // Raw sha256 is of the ORIGINAL uncompressed content.
    const { createHash } = await import("node:crypto");
    expect(summary.sha256).toBe(createHash("sha256").update(raw).digest("hex"));

    // .gz exists, raw is gone.
    await expect(fs.stat(path.resolve(base, summary.logRef))).resolves.toBeTruthy();
    await expect(fs.stat(path.resolve(base, handle.logRef))).rejects.toThrow();
    // No stray tmp file.
    await expect(fs.stat(path.resolve(base, `${summary.logRef}.tmp`))).rejects.toThrow();

    // Decompressed bytes match original.
    expect(await readRawFromDisk(summary.logRef)).toBe(raw);
  });

  it("read parity after finalize: full, paginated, and mid-file offset", async () => {
    const store = storeAt(base);
    const { handle, raw } = await seedLines(store, 200);
    const rawBytes = Buffer.byteLength(raw, "utf8");
    const summary = await store.finalize(handle);
    const gzHandle: RunLogHandle = { store: "local_file", logRef: summary.logRef };

    // (a) full read matches original exactly.
    const full = await store.read(gzHandle, { offset: 0, limitBytes: rawBytes + 1000 });
    expect(full.content).toBe(raw);
    expect(full.nextOffset).toBeUndefined();

    // (b) paginated reads reassemble with correct nextOffset chaining.
    const paginated = await readAllPaginated(store, gzHandle, 137);
    expect(paginated).toBe(raw);

    // (c) mid-file offset semantics match uncompressed slicing.
    const offset = Math.floor(rawBytes / 3);
    const limit = 500;
    const mid = await store.read(gzHandle, { offset, limitBytes: limit });
    const expectedSlice = Buffer.from(raw, "utf8").subarray(offset, offset + limit).toString("utf8");
    expect(mid.content).toBe(expectedSlice);
    expect(mid.nextOffset).toBe(offset + Buffer.byteLength(mid.content, "utf8"));
  });

  it("legacy fallback: .ndjson ref while only .ndjson.gz exists on disk", async () => {
    const store = storeAt(base);
    const { handle, raw } = await seedLines(store, 50);
    const summary = await store.finalize(handle);
    expect(summary.logRef.endsWith(".gz")).toBe(true);

    // Simulate a legacy/crash-window DB row that still points at the raw ref.
    const legacyHandle: RunLogHandle = { store: "local_file", logRef: handle.logRef };
    const res = await store.read(legacyHandle, { offset: 0, limitBytes: 10_000_000 });
    expect(res.content).toBe(raw);
  });

  it("gzip-failure fallback: .gz ref while only raw .ndjson exists", async () => {
    // Compression disabled → raw remains; a .gz-suffixed ref must still resolve.
    process.env.PAPERCLIP_RUN_LOG_COMPRESS = "0";
    const store = storeAt(base);
    const { handle, raw } = await seedLines(store, 50);
    const summary = await store.finalize(handle);
    expect(summary.compressed).toBe(false);

    const gzHandle: RunLogHandle = { store: "local_file", logRef: `${handle.logRef}.gz` };
    const res = await store.read(gzHandle, { offset: 0, limitBytes: 10_000_000 });
    expect(res.content).toBe(raw);
  });

  it("compression disabled via env leaves raw file, compressed:false", async () => {
    process.env.PAPERCLIP_RUN_LOG_COMPRESS = "false";
    const store = storeAt(base);
    const { handle, raw } = await seedLines(store, 30);
    const rawBytes = Buffer.byteLength(raw, "utf8");

    const summary = await store.finalize(handle);
    expect(summary.compressed).toBe(false);
    expect(summary.bytes).toBe(rawBytes);
    expect(summary.logRef).toBe(handle.logRef);

    await expect(fs.stat(path.resolve(base, handle.logRef))).resolves.toBeTruthy();
    await expect(fs.stat(path.resolve(base, `${handle.logRef}.gz`))).rejects.toThrow();

    const res = await store.read(handle, { offset: 0, limitBytes: 10_000_000 });
    expect(res.content).toBe(raw);
  });
});
