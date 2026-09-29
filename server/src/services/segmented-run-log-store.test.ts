import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { StorageProvider } from "../storage/types.js";
import { createSegmentedRunLogStore } from "./segmented-run-log-store.js";
import { createDurableRunLogStore, type RunLogHandle, type RunLogStore } from "./run-log-store.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true }))); });
async function temporary() { const root = await fs.mkdtemp(join(tmpdir(), "paperclip-log-segments-")); roots.push(root); return root; }
const binding = { companyId: "company", agentId: "agent", runId: "run" };
const event = (chunk: string) => ({ stream: "stdout" as const, ts: "2026-09-28T00:00:00Z", chunk });
function storage() {
  const objects = new Map<string, Buffer>();
  const writes: Array<{ key: string; bytes: number }> = [];
  const etag = (bytes: Buffer) => `"${createHash("sha256").update(bytes).digest("hex")}"`;
  const provider: StorageProvider = {
    id: "s3",
    async putObject(input) {
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBe(input.contentLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(input.sha256);
      writes.push({ key: input.objectKey, bytes: bytes.length });
      objects.set(input.objectKey, bytes);
    },
    async putObjectConditional(input, expected) {
      const previous = objects.get(input.objectKey);
      if (expected === null ? previous !== undefined : previous === undefined || etag(previous) !== expected) {
        throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed" });
      }
      // Tests have one atomic in-memory storage operation. Consuming a stream
      // may yield; check the condition again at actual publication below.
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(input.body)) chunks.push(input.body);
      else for await (const chunk of input.body) chunks.push(Buffer.from(chunk));
      const current = objects.get(input.objectKey);
      if (expected === null ? current !== undefined : current === undefined || etag(current) !== expected) throw Object.assign(new Error("precondition failed"), { name: "PreconditionFailed" });
      const bytes = Buffer.concat(chunks);
      expect(bytes.length).toBe(input.contentLength);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(input.sha256);
      writes.push({ key: input.objectKey, bytes: bytes.length }); objects.set(input.objectKey, bytes);
      return { etag: etag(bytes) };
    },
    async getObject(input) {
      const bytes = objects.get(input.objectKey);
      if (!bytes) throw Object.assign(new Error("object_missing"), { status: 404 });
      const selected = input.range ? bytes.subarray(input.range.start, input.range.end + 1) : bytes;
      return { stream: Readable.from(selected), contentLength: selected.length, etag: etag(bytes) };
    },
    async headObject(input) { const value = objects.get(input.objectKey); return value ? { exists: true, contentLength: value.length, etag: etag(value) } : { exists: false }; },
    async deleteObject(input) { objects.delete(input.objectKey); },
  };
  return { provider, objects, writes };
}

it.each([false, true])("queues a task page's concurrent old log reads with bounded I/O (read failure: %s)", async failOne => {
  const basePath = await temporary(), { provider } = storage();
  const writer = createSegmentedRunLogStore({ basePath, segmentBytes: 1024, s3: { provider } });
  const handles: RunLogHandle[] = [];
  for (let index = 0; index < 12; index++) {
    const handle = await writer.begin({ ...binding, runId: `read-${index}` });
    await writer.append(handle, event(`history ${index}`)); handles.push(handle);
  }
  await writer.flushInflightMirrors!();
  const original = provider.getObject.bind(provider);
  let active = 0, peak = 0, reads = 0;
  vi.spyOn(provider, "getObject").mockImplementation(async input => {
    if (!input.objectKey.includes("/tails/")) return original(input);
    active++; peak = Math.max(peak, active); reads++;
    try {
      // Hold each body request across an event-loop turn so all twelve HTTP
      // equivalents contend for admission rather than completing serially.
      await new Promise(resolve => setTimeout(resolve, 10));
      if (failOne && input.objectKey.startsWith(handles[0]!.logRef + "/")) throw new Error("qualified body read failure");
      return await original(input);
    } finally { active--; }
  });
  const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
  const pages = await Promise.allSettled(handles.map(handle => reader.read(handle)));
  expect(peak).toBe(2);
  expect(reads).toBe(12);
  for (const [index, page] of pages.entries()) {
    if (failOne && index === 0) expect(page).toMatchObject({ status: "rejected", reason: { message: "qualified body read failure" } });
    else expect(page).toMatchObject({ status: "fulfilled", value: { content: JSON.stringify(event(`history ${index}`)) + "\n" } });
  }
  expect(active).toBe(0);
});

it("bounds the log-read waiting queue and reports HTTP backpressure rather than an internal error", async () => {
  const basePath = await temporary(), { provider } = storage();
  const writer = createSegmentedRunLogStore({ basePath, segmentBytes: 1024, s3: { provider } });
  const handles: RunLogHandle[] = [];
  for (let index = 0; index < 70; index++) {
    const handle = await writer.begin({ ...binding, runId: `queue-${index}` });
    await writer.append(handle, event(`history ${index}`)); handles.push(handle);
  }
  await writer.flushInflightMirrors!();
  const original = provider.getObject.bind(provider);
  let release!: () => void, entered = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(provider, "getObject").mockImplementation(async input => {
    if (input.objectKey.includes("/tails/")) { entered++; await blocked; }
    return original(input);
  });
  const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
  const rejected: unknown[] = [];
  const pending = Promise.allSettled(handles.map(handle => reader.read(handle).catch(error => { rejected.push(error); throw error; })));
  try {
    await vi.waitFor(() => { expect(entered).toBe(2); expect(rejected).toHaveLength(4); });
    expect(rejected.every(error => (error as { status?: number }).status === 429)).toBe(true);
    release();
    expect((await pending).filter(result => result.status === "fulfilled")).toHaveLength(66);
    // Credits return after completion; the rejected requests can retry.
    expect((await reader.read(handles[69]!)).content).toContain("history 69");
  } finally { release(); await pending; }
});

it("refreshes two retired tails while newer requests are queued without waiting on its own credit", async () => {
  const basePath = await temporary(), { provider, objects } = storage();
  const writer = createSegmentedRunLogStore({ basePath, segmentBytes: 4096, s3: { provider } });
  const handles = await Promise.all([0, 1].map(index => writer.begin({ ...binding, runId: `retired-${index}` })));
  const first = event("old checkpoint"), next = event("next checkpoint");
  for (const handle of handles) await writer.append(handle, first);
  await writer.flushInflightMirrors!();
  const oldKeys = new Set(handles.map(handle => `${handle.logRef}/${JSON.parse(objects.get(`${handle.logRef}/head.json`)!.toString()).tailObject}`));
  const original = provider.getObject.bind(provider);
  let release!: () => void, entered = 0;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(provider, "getObject").mockImplementation(async input => {
    if (oldKeys.has(input.objectKey)) { entered++; await blocked; }
    return original(input);
  });
  const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
  const oldReads = Promise.all(handles.map(handle => reader.read(handle)));
  void oldReads.catch(() => {});
  let newReads: Promise<unknown[]> | undefined;
  try {
    await vi.waitFor(() => expect(entered).toBe(2));
    for (const handle of handles) await writer.append(handle, next);
    await writer.flushInflightMirrors!();
    expect([...oldKeys].every(key => !objects.has(key))).toBe(true);
    newReads = Promise.all(handles.map(handle => reader.read(handle)));
    void newReads.catch(() => {});
    // Both newer requests reach the queue before the old snapshots refresh.
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    for (const page of await oldReads) expect(page.content).toBe(JSON.stringify(first) + "\n");
    for (const page of await newReads) expect(page).toMatchObject({ content: [first, next].map(value => JSON.stringify(value) + "\n").join("") });
  } finally { release(); await Promise.allSettled([oldReads, ...(newReads ? [newReads] : [])]); }
});

async function all(store: RunLogStore, handle: RunLogHandle, limitBytes = 83) {
  let cursor = "0", content = "";
  for (;;) {
    const page = await store.read(handle, { cursor, limitBytes });
    content += page.content;
    if (!page.hasMore) return content;
    expect(BigInt(page.cursor!)).toBeGreaterThan(BigInt(cursor));
    cursor = page.cursor!;
  }
}

it("rejects a late old tail publication after a replacement claims the remote head", async () => {
  const { provider } = storage(), oldPath = await temporary(), nextPath = await temporary();
  let reached!: () => void, release!: () => void, armed = false;
  const blocked = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const old = createSegmentedRunLogStore({ basePath: oldPath, segmentBytes: 1024, s3: { provider },
    onBoundary: async boundary => { if (armed && boundary === "remote-tail") { armed = false; reached(); await resumed; } } });
  const handle = await old.begin(binding), first = event("original"), stale = event("stale"), next = event("new owner");
  await old.append(handle, first); await old.flushInflightMirrors!();
  await old.append(handle, stale); armed = true;
  const pending = old.flushInflightMirrors!(); void pending.catch(() => {});
  try {
    await blocked;
    const replacement = createSegmentedRunLogStore({ basePath: nextPath, s3: { provider } });
    await replacement.begin(binding); await replacement.append(handle, next); await replacement.flushInflightMirrors!();
    release(); await expect(pending).rejects.toThrow("precondition failed");
    const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
    expect(await all(reader, handle)).toBe([first, next].map(value => JSON.stringify(value) + "\n").join(""));
    // The old local tail cannot be adopted as an unmirrored successor of the
    // replacement's journal merely because its byte count is greater.
    await expect(createSegmentedRunLogStore({ basePath: oldPath, s3: { provider } }).begin(binding)).rejects.toThrow("remote_owner_changed");
  } finally { release(); await pending.catch(() => {}); }
});

it("replaces an uncommitted remote segment reference without overwriting immutable content", async () => {
  const { provider } = storage(), basePath = await temporary();
  let armed = false;
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 256, s3: { provider },
    onBoundary: async boundary => { if (armed && boundary === "segment") { armed = false; throw new Error("crashed before local publication"); } } });
  const handle = await store.begin(binding), first = event("first"), next = event("continued " + "n".repeat(700));
  await store.append(handle, first); await store.flushInflightMirrors!(); armed = true;
  await expect(store.append(handle, event("x".repeat(700)))).rejects.toThrow("crashed");
  store = createSegmentedRunLogStore({ basePath, s3: { provider } });
  await store.begin(binding); await store.append(handle, next); await store.flushInflightMirrors!();
  const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
  expect(await all(reader, handle)).toBe([first, next].map(value => JSON.stringify(value) + "\n").join(""));
});

it("fences a paused segment writer after another owner publishes different content", async () => {
  const { provider } = storage(), oldPath = await temporary();
  let reached!: () => void, release!: () => void, armed = false;
  const blocked = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const old = createSegmentedRunLogStore({ basePath: oldPath, segmentBytes: 256, s3: { provider },
    onBoundary: async boundary => { if (armed && boundary === "segment") { armed = false; reached(); await resumed; } } });
  const handle = await old.begin(binding), first = event("first"), next = event("n".repeat(900));
  await old.append(handle, first); await old.flushInflightMirrors!(); armed = true;
  const pending = old.append(handle, event("o".repeat(900))); void pending.catch(() => {});
  try {
    await blocked;
    const replacement = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
    await replacement.begin(binding); await replacement.append(handle, next); await replacement.flushInflightMirrors!();
    release(); await expect(pending).rejects.toThrow("remote_owner_changed");
    const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
    expect(await all(reader, handle)).toBe([first, next].map(value => JSON.stringify(value) + "\n").join(""));
  } finally { release(); await pending.catch(() => {}); }
});

it("changes reference identity even for identical bytes so a late orphan update cannot win an ETag ABA", async () => {
  const { provider } = storage(), oldPath = await temporary();
  const first = event("first"), segment = event("x".repeat(400));
  let armed = false;
  const seed = createSegmentedRunLogStore({ basePath: oldPath, segmentBytes: 256, s3: { provider },
    onBoundary: async boundary => { if (armed && boundary === "segment") { armed = false; throw new Error("orphan"); } } });
  const handle = await seed.begin(binding); await seed.append(handle, first); await seed.flushInflightMirrors!(); armed = true;
  await expect(seed.append(handle, segment)).rejects.toThrow("orphan");
  const old = createSegmentedRunLogStore({ basePath: oldPath, s3: { provider } }); await old.begin(binding);
  let reached!: () => void, release!: () => void;
  const blocked = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const original = provider.putObjectConditional!.bind(provider);
  let pause = true;
  vi.spyOn(provider, "putObjectConditional").mockImplementation(async (input, expected) => {
    if (pause && input.objectKey.endsWith("/00.ndjson.json")) {
      pause = false; expect(expected).not.toBeNull(); reached(); await resumed;
    }
    return original(input, expected);
  });
  const pending = old.append(handle, segment); void pending.catch(() => {});
  try {
    await blocked;
    const replacement = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
    await replacement.begin(binding); await replacement.append(handle, segment); await replacement.flushInflightMirrors!();
    release(); await expect(pending).rejects.toThrow("precondition failed");
    const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
    expect(await all(reader, handle)).toBe([first, segment].map(value => JSON.stringify(value) + "\n").join(""));
  } finally { release(); await pending.catch(() => {}); }
});

it.each(["append", "replace"] as const)("reclaims old mirrored tails while a reader holds its prior head (%s)", async action => {
  const { provider, objects } = storage(), basePath = await temporary();
  const writer = createSegmentedRunLogStore({ basePath, segmentBytes: 4096, s3: { provider } });
  const handle = await writer.begin(binding), first = event("first");
  await writer.append(handle, first); await writer.flushInflightMirrors!();
  const head = JSON.parse(objects.get(`${handle.logRef}/head.json`)!.toString());
  let reached!: () => void, release!: () => void;
  const blocked = new Promise<void>(resolve => { reached = resolve; });
  const resumed = new Promise<void>(resolve => { release = resolve; });
  const original = provider.getObject.bind(provider);
  let pause = true;
  vi.spyOn(provider, "getObject").mockImplementation(async input => {
    if (pause && input.objectKey === `${handle.logRef}/${head.tailObject}`) {
      pause = false; reached(); await resumed;
    }
    return original(input);
  });
  const reader = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
  const pending = reader.read(handle); void pending.catch(() => {});
  try {
    await blocked;
    if (action === "replace") {
      const replacement = createSegmentedRunLogStore({ basePath: await temporary(), s3: { provider } });
      await replacement.begin(binding);
    } else {
      for (let index = 0; index < 12; index++) {
        await writer.append(handle, event(`next ${index}`)); await writer.flushInflightMirrors!();
      }
    }
    expect(objects.has(`${handle.logRef}/${head.tailObject}`)).toBe(false);
    expect([...objects.keys()].filter(key => key.includes("/tails/"))).toHaveLength(1);
    release(); expect((await pending).content).toBe(JSON.stringify(first) + "\n");
  } finally { release(); await pending.catch(() => {}); }
});

it("retains one pending tail deletion through cleanup failure and resumes it on reopen", async () => {
  const { provider, objects } = storage(), basePath = await temporary();
  let writer = createSegmentedRunLogStore({ basePath, segmentBytes: 1024, s3: { provider } });
  const handle = await writer.begin(binding);
  await writer.append(handle, event("first")); await writer.flushInflightMirrors!();
  await writer.append(handle, event("next"));
  const remove = vi.spyOn(provider, "deleteObject").mockRejectedValueOnce(new Error("deletion offline"));
  await expect(writer.flushInflightMirrors!()).rejects.toThrow("deletion offline");
  const head = JSON.parse(objects.get(`${handle.logRef}/head.json`)!.toString());
  expect(head.retiredTail).toBeDefined();
  expect(objects.has(`${handle.logRef}/${head.retiredTail}`)).toBe(true);
  await expect(writer.append(handle, event("cannot accumulate more garbage"))).rejects.toThrow("writer_fenced");
  remove.mockRestore();
  writer = createSegmentedRunLogStore({ basePath, s3: { provider } }); await writer.begin(binding);
  expect([...objects.keys()].filter(key => key.includes("/tails/"))).toHaveLength(1);
  expect(await all(writer, handle)).toContain("next");
});

it("reads retained v1 remote segments and explicitly publishes v2 when a writer takes ownership", async () => {
  const { provider, objects } = storage(), basePath = await temporary();
  let writer = createSegmentedRunLogStore({ basePath, segmentBytes: 256, s3: { provider } });
  const handle = await writer.begin(binding);
  await writer.append(handle, event("old format " + "x".repeat(600))); await writer.flushInflightMirrors!();
  const expected = await all(writer, handle);
  // Reconstruct the original v1 shape, including fixed object names.
  const head = JSON.parse(objects.get(`${handle.logRef}/head.json`)!.toString());
  objects.set(`${handle.logRef}/tails/${head.revision}.ndjson`, objects.get(`${handle.logRef}/${head.tailObject}`)!);
  head.schema = "paperclip.run-log.segments.v1"; delete head.writerId; delete head.tailObject; delete head.retiredTail;
  objects.set(`${handle.logRef}/head.json`, Buffer.from(JSON.stringify(head)));
  for (const [key, bytes] of [...objects]) if (key.includes("/segments/") && key.endsWith(".json")) {
    const reference = JSON.parse(bytes.toString());
    objects.set(key.slice(0, -5), objects.get(`${handle.logRef}/${reference.object}`)!);
    reference.schema = "paperclip.run-log.segment.v1"; delete reference.object; delete reference.writerId;
    objects.set(key, Buffer.from(JSON.stringify(reference)));
  }
  await fs.rm(basePath, { recursive: true });
  writer = createSegmentedRunLogStore({ basePath, s3: { provider } });
  expect(await all(writer, handle)).toBe(expected);
  await writer.begin(binding);
  expect(JSON.parse(objects.get(`${handle.logRef}/head.json`)!.toString()).schema).toBe("paperclip.run-log.segments.v2");
  const next = event("new format " + "n".repeat(500));
  await writer.append(handle, next); await writer.flushInflightMirrors!();
  expect(await all(writer, handle)).toBe(expected + JSON.stringify(next) + "\n");
});

it("rotates real bytes, survives reopen, and reads UTF-8 across segment/page boundaries", async () => {
  const basePath = await temporary();
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 128 });
  const handle = await store.begin(binding);
  let expected = "";
  for (let i = 0; i < 20; i++) {
    const value = event(`${i}: 🦀 café 漢字 ${"x".repeat(61)}`);
    await store.append(handle, value); expected += `${JSON.stringify(value)}\n`;
  }
  store = createSegmentedRunLogStore({ basePath, segmentBytes: 256 });
  expect(await store.begin(binding)).toEqual(handle); // Persisted segment size wins.
  const resumed = event("resumed");
  await store.append(handle, resumed); expected += `${JSON.stringify(resumed)}\n`;
  expect(await all(store, handle, 67)).toBe(expected);
  expect(await store.finalize(handle)).toEqual({ bytes: Buffer.byteLength(expected), bytesExact: String(Buffer.byteLength(expected)), compressed: false });
  expect(await store.read(handle, { cursor: String(Buffer.byteLength(expected)) })).toMatchObject({ content: "", hasMore: false, cursor: String(Buffer.byteLength(expected)) });
  const head = await fs.readFile(join(basePath, handle.logRef, "head.json"));
  expect(head.length).toBeLessThan(512);
});

it("positions appends across segment boundaries and resumes exact byte cursors after reopen", async () => {
  const basePath = await temporary();
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 128 });
  const handle = await store.begin(binding);
  const first = event("é🦀" + "a".repeat(150));
  const firstReceipt = await store.appendPositioned!(handle, first);
  expect(firstReceipt.cursor).toBe("0");
  expect(firstReceipt.bytes).toBe(Buffer.byteLength(`${JSON.stringify({ ...first, cursor: "0" })}\n`));
  const second = event("second 漢字");
  const secondReceipt = await store.appendPositioned!(handle, second);
  expect(secondReceipt.cursor).toBe(firstReceipt.nextCursor);
  expect(secondReceipt.nextCursor).toBe(String(BigInt(secondReceipt.cursor) + BigInt(secondReceipt.bytes)));

  store = createSegmentedRunLogStore({ basePath, segmentBytes: 256 });
  expect(await store.begin(binding)).toEqual(handle);
  const third = event("after reopen 🦀");
  const thirdReceipt = await store.appendPositioned!(handle, third);
  expect(thirdReceipt.cursor).toBe(secondReceipt.nextCursor);
  const whole = [first, second, third].map((value, index) => {
    const cursor = [firstReceipt, secondReceipt, thirdReceipt][index]!.cursor;
    return `${JSON.stringify({ ...value, cursor })}\n`;
  }).join("");
  expect(await all(store, handle)).toBe(whole);
});

it("reads a bounded tail page and continues with the exact decimal cursor", async () => {
  const basePath = await temporary();
  const store = createSegmentedRunLogStore({ basePath, segmentBytes: 128 });
  const handle = await store.begin(binding);
  for (let i = 0; i < 12; i++) await store.append(handle, event(`${i}: ${"x".repeat(30)}`));
  const total = BigInt((await fs.readFile(join(basePath, handle.logRef, "head.json"), "utf8")).match(/"bytes":"(\d+)"/)![1]!);
  let page = await store.read(handle, { cursor: "tail", limitBytes: 80 });
  expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(80);
  expect(page.content).toContain('"chunk":"11: ');
  while (page.hasMore) page = await store.read(handle, { cursor: page.cursor, limitBytes: 80 });
  expect(BigInt(page.cursor!)).toBe(total);
  const appended = event("arrived after tail page");
  await store.append(handle, appended);
  const resumed = await store.read(handle, { cursor: page.cursor, limitBytes: 256 });
  expect(resumed.content).toBe(`${JSON.stringify(appended)}\n`);
  expect(resumed.hasMore).toBe(false);
});

it("routes a synthetic committed segment and tail cursor above MAX_SAFE_INTEGER exactly", async () => {
  const basePath = await temporary();
  const store = createSegmentedRunLogStore({ basePath, segmentBytes: 128 });
  const handle = await store.begin(binding);
  const tail = Buffer.from(`${JSON.stringify(event("high-offset-" + "x".repeat(40)))}\n`);
  const segmentBytes = 128n;
  const index = (BigInt(Number.MAX_SAFE_INTEGER) / segmentBytes) + 2n;
  const total = index * segmentBytes + BigInt(tail.length);
  const hex = index.toString(16).padStart(4, "0");
  const relative = `segments/${hex.slice(0, -2)}/${hex.slice(-2)}.ndjson`;
  const segmentPath = join(basePath, handle.logRef, relative);
  await fs.mkdir(join(segmentPath, ".."), { recursive: true, mode: 0o700 });
  await fs.writeFile(segmentPath, tail, { mode: 0o600 });
  await fs.chmod(segmentPath, 0o600);
  await fs.writeFile(join(basePath, handle.logRef, "head.json"), JSON.stringify({
    schema: "paperclip.run-log.segments.v2", logRef: handle.logRef, segmentBytes: 128,
    bytes: String(total), lastRecordCursor: String(index * segmentBytes), revision: "2", tailSha256: createHash("sha256").update(tail).digest("hex"), finalized: false,
  }), { mode: 0o600 });
  await fs.chmod(join(basePath, handle.logRef, "head.json"), 0o600);

  const reader = createSegmentedRunLogStore({ basePath });
  let page = await reader.read(handle, { cursor: "tail", limitBytes: 48 });
  expect(BigInt(page.cursor!)).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  let content = page.content;
  while (page.hasMore) { page = await reader.read(handle, { cursor: page.cursor, limitBytes: 48 }); content += page.content; }
  expect(page.cursor).toBe(String(total));
  expect(content).toBe(tail.toString());
  expect(page.hasMore).toBe(false);
});

it.each([false, true])("pages a final record larger than the tail window after reopen (retained head: %s)", async retained => {
  const basePath = await temporary();
  const store = createSegmentedRunLogStore({ basePath, segmentBytes: 64 * 1024 });
  const handle = await store.begin(binding);
  await store.append(handle, event("earlier output"));
  const final = event("🙂大".repeat(100_000));
  const receipt = await store.appendPositioned!(handle, final);
  await store.finalize(handle);
  const path = join(basePath, handle.logRef, "head.json");
  if (retained) {
    const head = JSON.parse(await fs.readFile(path, "utf8"));
    delete head.lastRecordCursor;
    await fs.writeFile(path, JSON.stringify(head));
  }
  const reader = createSegmentedRunLogStore({ basePath });
  let page = await reader.read(handle, { cursor: "tail", limitBytes: 256_000 });
  expect(page.hasMore).toBe(true);
  let encoded = page.content, requests = 1;
  while (page.hasMore) {
    expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(256_000);
    const previous = page.cursor;
    page = await reader.read(handle, { cursor: previous, limitBytes: 256_000 });
    expect(BigInt(page.cursor!)).toBeGreaterThan(BigInt(previous!));
    encoded += page.content;
    expect(++requests).toBeLessThan(10);
  }
  expect(JSON.parse(encoded)).toEqual({ ...final, cursor: receipt.cursor });
  expect(page.cursor).toBe(receipt.nextCursor);
});

it.each(["local", "s3"] as const)("rejects corrupt historical segment bytes before returning a %s page", async backend => {
  const basePath = await temporary(), { provider, objects } = storage();
  const options = { basePath, segmentBytes: 256, ...(backend === "s3" ? { s3: { provider } } : {}) };
  const writer = createSegmentedRunLogStore(options), handle = await writer.begin(binding);
  await writer.append(handle, event("x".repeat(800)));
  await writer.flushInflightMirrors!();
  if (backend === "local") {
    const path = join(basePath, handle.logRef, "segments/00/00.ndjson");
    const bytes = await fs.readFile(path); bytes[200] ^= 1; await fs.writeFile(path, bytes);
  } else {
    const ref = JSON.parse(objects.get(`${handle.logRef}/segments/00/00.ndjson.json`)!.toString());
    const key = `${handle.logRef}/${ref.object}`;
    const bytes = Buffer.from(objects.get(key)!); bytes[200] ^= 1; objects.set(key, bytes);
    await fs.rm(basePath, { recursive: true });
  }
  const reader = createSegmentedRunLogStore(options);
  // The damaged byte is outside this small requested page. The fixed-size
  // segment must still verify before any of its content is displayed.
  await expect(reader.read(handle, { limitBytes: 64 })).rejects.toThrow("segment_digest_mismatch");
});

it("rejects a changed remote segment binding and verifies each cached body once", async () => {
  const basePath = await temporary(), { provider, objects } = storage();
  const writer = createSegmentedRunLogStore({ basePath, segmentBytes: 1024, s3: { provider } });
  const handle = await writer.begin(binding);
  await writer.append(handle, event("x".repeat(1600))); await writer.flushInflightMirrors!();
  await fs.rm(basePath, { recursive: true });
  const reads = vi.spyOn(provider, "getObject");
  const reader = createSegmentedRunLogStore({ basePath, s3: { provider } });
  await reader.read(handle, { cursor: "0", limitBytes: 64 });
  await reader.read(handle, { cursor: "64", limitBytes: 64 });
  expect(reads.mock.calls.filter(([input]) => /\/00\.ndjson\.[a-f0-9]{64}$/.test(input.objectKey))).toHaveLength(1);
  const key = `${handle.logRef}/segments/00/00.ndjson.json`;
  const reference = JSON.parse(objects.get(key)!.toString()); reference.logRef = "another/agent/run.segments";
  objects.set(key, Buffer.from(JSON.stringify(reference)));
  await expect(createSegmentedRunLogStore({ basePath, s3: { provider } }).read(handle)).rejects.toThrow("segment_reference_invalid");
});

it("reopen, append and finalize do not require any completed historical segments", async () => {
  const basePath = await temporary();
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 128 });
  const handle = await store.begin(binding);
  await store.append(handle, event("a".repeat(4096)));
  await fs.rm(join(basePath, handle.logRef, "segments/00/00.ndjson"));
  store = createSegmentedRunLogStore({ basePath });
  const old = JSON.parse(await fs.readFile(join(basePath, handle.logRef, "head.json"), "utf8"));
  await store.begin(binding);
  await store.append(handle, event("next"));
  expect((await store.read(handle, { cursor: old.bytes })).content).toContain("next");
  await store.finalize(handle);
  await expect(store.read(handle)).rejects.toThrow();
});

it.each(["segment", "head"] as const)("recovers interruption at %s without publishing uncommitted bytes", async boundary => {
  const basePath = await temporary();
  let armed = false;
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 128, onBoundary: async point => { if (armed && point === boundary) { armed = false; throw new Error("interrupted"); } } });
  const handle = await store.begin(binding);
  const first = event("first");
  await store.append(handle, first);
  const second = event("b".repeat(300));
  armed = true;
  await expect(store.append(handle, second)).rejects.toThrow("interrupted");
  await expect(store.append(handle, event("unsafe retry"))).rejects.toThrow("writer_fenced");
  store = createSegmentedRunLogStore({ basePath });
  await store.begin(binding);
  const third = event("third");
  await store.append(handle, third);
  expect(await all(store, handle)).toBe([first, ...(boundary === "head" ? [second] : []), third].map(value => `${JSON.stringify(value)}\n`).join(""));
});

it("uploads closed segments once, mirrors only the current tail, and restores after a pod loss", async () => {
  const basePath = await temporary();
  const { provider, writes } = storage();
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 256, s3: { provider } });
  const handle = await store.begin(binding);
  const first = event("f".repeat(3000));
  await store.append(handle, first);
  await store.flushInflightMirrors!();
  const count = writes.length;
  await store.append(handle, event("tail"));
  await store.flushInflightMirrors!();
  expect(writes.slice(count).every(write => write.bytes < 1024)).toBe(true);
  const completed = writes.filter(write => write.key.includes("/segments/"));
  expect(new Set(completed.map(write => write.key)).size).toBe(completed.length);
  const before = await all(store, handle);
  await fs.rm(basePath, { recursive: true });
  store = createSegmentedRunLogStore({ basePath, s3: { provider } });
  expect(await all(store, handle)).toBe(before);
  await store.begin(binding); // Restore only the head and current tail.
  const next = event("continued after pod loss");
  await store.append(handle, next);
  expect(await all(store, handle)).toBe(before + JSON.stringify(next) + "\n");
  const finalized = await store.finalize(handle);
  await fs.rm(basePath, { recursive: true });
  expect(await all(store, handle)).toBe(before + JSON.stringify(next) + "\n");
  expect(finalized.bytes).toBe(Buffer.byteLength(before + JSON.stringify(next) + "\n"));
});

it.each(["remote-tail", "remote-head"] as const)("an interruption at %s exposes only a complete remote generation", async boundary => {
  const basePath = await temporary();
  const { provider } = storage();
  let armed = false;
  const store = createSegmentedRunLogStore({ basePath, segmentBytes: 256, s3: { provider }, onBoundary: async point => { if (armed && point === boundary) { armed = false; throw new Error("interrupted"); } } });
  const handle = await store.begin(binding);
  const first = event("first"); await store.append(handle, first); await store.flushInflightMirrors!();
  const second = event("second"); await store.append(handle, second);
  armed = true;
  await expect(store.flushInflightMirrors!()).rejects.toThrow("interrupted");
  await fs.rm(basePath, { recursive: true });
  const reader = createSegmentedRunLogStore({ basePath, s3: { provider } });
  expect(await all(reader, handle)).toBe([first, ...(boundary === "remote-head" ? [second] : [])].map(value => JSON.stringify(value) + "\n").join(""));
});

it("retains format across rollout changes and never truncates an existing log on begin", async () => {
  const basePath = await temporary();
  let store = createDurableRunLogStore({ basePath, segmented: true });
  const handle = await store.begin(binding);
  await store.append(handle, event("retained"));
  store = createDurableRunLogStore({ basePath, segmented: false });
  expect(await store.begin(binding)).toEqual(handle);
  expect((await store.read(handle)).content).toContain("retained");
  const old = await store.begin({ ...binding, runId: "legacy" });
  await store.append(old, event("legacy retained"));
  store = createDurableRunLogStore({ basePath, segmented: true });
  expect(await store.begin({ ...binding, runId: "legacy" })).toEqual(old);
  expect((await store.read(old)).content).toContain("legacy retained");
});

it("creates a private segmented run beneath existing legacy company/agent directories", async () => {
  const basePath = await temporary();
  const legacy = createDurableRunLogStore({ basePath });
  const old = await legacy.begin(binding);
  await legacy.append(old, event("old"));
  const indexed = createDurableRunLogStore({ basePath, segmented: true });
  const current = await indexed.begin({ ...binding, runId: "next" });
  await indexed.append(current, event("new"));
  expect((await indexed.read(current)).content).toContain("new");
  expect((await indexed.read(old)).content).toContain("old");
});

it("serializes concurrent first appends after reopen without losing bytes", async () => {
  const basePath = await temporary();
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 128 });
  const handle = await store.begin(binding);
  store = createSegmentedRunLogStore({ basePath });
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.append(handle, event(String(i)))));
  expect((await all(store, handle)).trim().split("\n").map(line => JSON.parse(line).chunk)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"]);
});

it("fences an upload failure and recovers only when begin reopens its durable head", async () => {
  const basePath = await temporary();
  const { provider } = storage();
  const store = createSegmentedRunLogStore({ basePath, segmentBytes: 128, s3: { provider } });
  const handle = await store.begin(binding);
  const first = event("first");
  await store.append(handle, first);
  const put = vi.spyOn(provider, "putObjectConditional").mockRejectedValueOnce(new Error("storage offline"));
  await expect(store.append(handle, event("x".repeat(200)))).rejects.toThrow("storage offline");
  await expect(store.append(handle, event("unsafe"))).rejects.toThrow("writer_fenced");
  put.mockRestore();
  await store.begin(binding);
  const next = event("recovered");
  await store.append(handle, next);
  expect(await all(store, handle)).toBe([first, next].map(value => JSON.stringify(value) + "\n").join(""));
});

it("rejects corrupt tails and symlinked segment directories", async () => {
  const basePath = await temporary();
  let store = createSegmentedRunLogStore({ basePath, segmentBytes: 128 });
  const handle = await store.begin(binding);
  await store.append(handle, event("first"));
  const file = join(basePath, handle.logRef, "segments/00/00.ndjson");
  const original = await fs.readFile(file);
  await fs.writeFile(file, Buffer.alloc(original.length, 0x78));
  store = createSegmentedRunLogStore({ basePath });
  await expect(store.begin(binding)).rejects.toThrow("digest_mismatch");
  await fs.writeFile(file, original);
  const directory = join(basePath, handle.logRef, "segments/00");
  await fs.rename(directory, `${directory}-old`);
  await fs.symlink(`${directory}-old`, directory);
  await expect(store.read(handle)).rejects.toThrow("directory_unsafe");
});
