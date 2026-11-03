import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { createObjectRunLogStore } from "./object-run-log-store.js";

async function readBody(body: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const bytes of body) chunks.push(Buffer.from(bytes));
  return Buffer.concat(chunks);
}

function memory() {
  const objects = new Map<string, Buffer>();
  let puts = 0,
    unavailable = false;
  const etag = (b: Buffer) => createHash("sha256").update(b).digest("hex");
  const provider: StorageProvider = {
    id: "s3",
    async putObject() {
      throw Error("unconditional");
    },
    async putObjectConditional(i) {
      if (unavailable) throw Error("storage offline");
      const old = objects.get(i.objectKey);
      if (i.ifNoneMatch ? old : !old || etag(old) !== i.ifMatch)
        throw Object.assign(Error("conflict"), { name: "PreconditionFailed" });
      const b = Buffer.isBuffer(i.body) ? i.body : await readBody(i.body);
      objects.set(i.objectKey, Buffer.from(b));
      puts++;
      return { etag: etag(b) };
    },
    async getObject(i) {
      const b = objects.get(i.objectKey);
      if (!b) throw Object.assign(Error("missing"), { name: "NoSuchKey" });
      return { stream: Readable.from([b]), etag: etag(b) };
    },
    async headObject(i) {
      return { exists: objects.has(i.objectKey) };
    },
    async deleteObject(i) {
      objects.delete(i.objectKey);
    },
    async listObjects(i) {
      return { keys: [...objects.keys()].filter((k) => k.startsWith(i.prefix)) };
    },
  };
  return {
    provider,
    puts: () => puts,
    offline: (value: boolean) => {
      unavailable = value;
    },
  };
}
const input = { companyId: "company", agentId: "agent", runId: "run" };
const event = (seq: number) => ({
  stream: "stdout" as const,
  chunk: "再開",
  ts: "2026-10-30T00:00:00Z",
  seq,
});

describe("S3 run log store", () => {
  it("batches concurrent appends, confirms durability, and resumes offsets/sequence on a replacement", async () => {
    const m = memory(),
      options = {
        provider: m.provider,
        keyPrefix: "logs",
        flushMs: 10,
        assertWriterAuthority: async () => undefined,
      };
    const a = createObjectRunLogStore(options),
      handle = await a.begin(input),
      before = m.puts();
    const sizes = await Promise.all(
      Array.from({ length: 100 }, (_, i) => a.append(handle, event(i + 1))),
    );
    expect(m.puts() - before).toBe(2);
    const b = createObjectRunLogStore(options);
    const read = await b.read(handle);
    expect(read.content.trim().split("\n")).toHaveLength(100);
    const successor = await b.begin(input);
    expect(successor.initialSequence).toBe(100);
    expect(successor.initialBytes).toBe(sizes.reduce((sum, size) => sum + size, 0));
    await b.append(successor, event(101));
    const summary = await b.finalize(successor);
    expect(summary.bytes).toBeGreaterThan(successor.initialBytes!);
    expect(summary.sha256).toBe(
      createHash("sha256")
        .update((await b.read(successor)).content)
        .digest("hex"),
    );
    await expect(a.append(handle, event(102))).rejects.toThrow("another writer");
  });
  it("finalization flushes already accepted writes and rejects later append admission", async () => {
    const m = memory(),
      store = createObjectRunLogStore({
        provider: m.provider,
        keyPrefix: "logs",
        flushMs: 1000,
        assertWriterAuthority: async () => undefined,
      });
    const h = await store.begin(input),
      pending = store.append(h, event(1));
    const finalizing = store.finalize(h);
    await expect(store.append(h, event(2))).rejects.toThrow("closed");
    const [size, result] = await Promise.all([pending, finalizing]);
    expect(result.bytes).toBe(size);
  });
  it("does not acknowledge a batch when storage fails", async () => {
    const m = memory(),
      store = createObjectRunLogStore({
        provider: m.provider,
        keyPrefix: "logs",
        flushMs: 1,
        assertWriterAuthority: async () => undefined,
      });
    const h = await store.begin(input);
    m.offline(true);
    await expect(store.append(h, event(1))).rejects.toThrow("storage offline");
    m.offline(false);
    expect((await store.read(h)).content).toBe("");
  });
  it("preserves UTF-8 and byte offsets across tiny pages and aligned tails", async () => {
    const m = memory(),
      store = createObjectRunLogStore({
        provider: m.provider,
        keyPrefix: "logs",
        flushMs: 1,
        assertWriterAuthority: async () => undefined,
      });
    const h = await store.begin(input);
    await store.append(h, { ...event(1), chunk: "再開😀" });
    await store.append(h, event(2));
    const full = Buffer.from((await store.read(h)).content);
    let offset = 0,
      text = "";
    for (;;) {
      const page = await store.read(h, { offset, limitBytes: 7 });
      text += page.content;
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(Buffer.from(text)).toEqual(full);
    const start = full.indexOf(Buffer.from("再")) + 1;
    const tail = await store.read(h, { offset: start, limitBytes: 1000, alignStartToRecord: true });
    expect(Buffer.from(tail.content)).toEqual(full);
  });
  it("backpressures admission at capacity without poisoning the writer or losing accepted output", async () => {
    const m = memory(),
      original = m.provider.putObjectConditional!;
    let release!: () => void,
      entered = false;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    m.provider.putObjectConditional = async (input) => {
      if (input.objectKey.includes("/objects/") && !entered) {
        entered = true;
        await blocked;
      }
      return original(input);
    };
    const store = createObjectRunLogStore({
      provider: m.provider,
      keyPrefix: "logs",
      assertWriterAuthority: async () => undefined,
    });
    const h = await store.begin(input);
    const first = await store.enqueue!(h, { ...event(1), chunk: "a".repeat(7 * 1024 * 1024) });
    await vi.waitFor(() => expect(entered).toBe(true));
    let admitted = false;
    const second = store.enqueue!(h, { ...event(2), chunk: "b".repeat(2 * 1024 * 1024) }).then(
      (receipt) => {
        admitted = true;
        return receipt.committed;
      },
    );
    await Promise.resolve();
    expect(admitted).toBe(false);
    release();
    await Promise.all([first.committed, second]);
    await store.append(h, event(3));
    expect((await store.finalize(h)).bytes).toBeGreaterThan(9 * 1024 * 1024);
  });
});
