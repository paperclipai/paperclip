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
    objects,
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
  it("awaits a successor flush started by another drain waiter before finalizing", async () => {
    const m = memory(), store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1000,
      segmentBytes: 1024, assertWriterAuthority: async () => undefined });
    const handle = await store.begin(input), put = m.provider.putObjectConditional!.bind(m.provider);
    let firstEntered!: () => void, secondEntered!: () => void, releaseFirst!: () => void, releaseSecond!: () => void;
    const firstStarted = new Promise<void>(resolve => { firstEntered = resolve; });
    const secondStarted = new Promise<void>(resolve => { secondEntered = resolve; });
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    let publications = 0;
    m.provider.putObjectConditional = async value => {
      if (value.objectKey.endsWith("/head.json") && Buffer.isBuffer(value.body)) {
        const head = JSON.parse(value.body.toString());
        if (!head.closed && head.end > 0) {
          publications++;
          if (publications === 1) { firstEntered(); await firstGate; }
          else if (publications === 2) { secondEntered(); await secondGate; }
        }
      }
      return put(value);
    };
    const first = await store.enqueue!(handle, { ...event(1), chunk: "first ".repeat(200) });
    const firstCommitted = first.committed.catch(error => error);
    await firstStarted;
    const second = await store.enqueue!(handle, { ...event(2), chunk: "second" });
    const secondCommitted = second.committed.catch(error => error);
    let finalized = false;
    const finalizing = store.finalize(handle).then(result => { finalized = true; return result; });
    releaseFirst();
    await secondStarted;
    await new Promise<void>(resolve => setImmediate(resolve));
    const finalizedBeforeSecondCommit = finalized;
    releaseSecond();
    const summary = await finalizing;
    const committed = await Promise.all([firstCommitted, secondCommitted]);
    const content = (await store.read(handle)).content;
    expect(finalizedBeforeSecondCommit).toBe(false);
    expect(committed.every(value => typeof value === "number")).toBe(true);
    expect(summary.bytes).toBe(Buffer.byteLength(content));
    expect(content.trim().split("\n").map(line => JSON.parse(line).seq)).toEqual([1, 2]);
  });

  it("rejects outer records exceeding 8MiB without losing later bounded appends", async () => {
    const m = memory(), store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async () => undefined });
    const handle = await store.begin(input);
    await expect(store.append(handle, { ...event(1), chunk: "x".repeat(8 * 1024 * 1024) }))
      .rejects.toThrow("Object run log record exceeds pending-byte limit");
    await store.append(handle, event(1));
    const content = (await store.read(handle)).content;
    expect(content.trim().split("\n")).toHaveLength(1);
    expect((await store.finalize(handle)).bytes).toBe(Buffer.byteLength(content));
  });

  it("keeps live byte appends deliverable after a proof-only outage and requires cold prefix verification", async () => {
    const m = memory(), options = { provider: m.provider, keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async () => undefined };
    const put = m.provider.putObjectConditional!.bind(m.provider);
    let proofUnavailable = false, proofFailures = 0;
    m.provider.putObjectConditional = async value => {
      if (proofUnavailable && value.objectKey.includes("/objects/source-prefix-proof-v1-")) {
        proofFailures++;
        throw Object.assign(new Error("proof storage unavailable"), { $metadata: { httpStatusCode: 503 } });
      }
      return put(value);
    };
    const store = createObjectRunLogStore(options), handle = await store.begin(input);
    await store.recordVerifiedSourcePrefix!(handle, 0);
    proofUnavailable = true;
    const first = await store.append(handle, { ...event(1), sourceCursor: 2, preservesSourceCoverage: true })
      .catch(error => error);
    // The existing byte/index/head publication succeeded despite the proof PUT failure.
    expect((await store.read(handle)).content.trim().split("\n")).toHaveLength(1);
    proofUnavailable = false;
    const second = await store.append(handle, { ...event(2), sourceCursor: 5, preservesSourceCoverage: true })
      .catch(error => error);
    const summary = await store.finalize(handle);
    const cold = createObjectRunLogStore(options), resumed = await cold.begin(input);
    const content = (await cold.read(resumed)).content;
    expect(resumed.initialSourceCursor).toBe(5);
    // Absence selects the maintained consumer's mandatory full source-prefix scan.
    expect(resumed.initialSourcePrefixVerified).toBe(false);
    proofUnavailable = true;
    // A complete legacy proof can advance the old max cursor before its optional
    // proof PUT fails. The public recorder must retain that known committed head.
    await cold.recordVerifiedSourcePrefix!(resumed, 8);
    expect(resumed.initialSourcePrefixVerified).toBe(false);
    proofUnavailable = false;
    const third = await cold.append(resumed, { ...event(3), sourceCursor: 11, preservesSourceCoverage: true });
    await cold.finalize(resumed);
    const final = await store.begin(input);
    const finalContent = (await store.read(final)).content;
    await store.finalize(final);
    expect(proofFailures).toBeGreaterThan(0);
    expect(first).toBeTypeOf("number");
    expect(second).toBeTypeOf("number");
    expect(third).toBeTypeOf("number");
    expect(summary.bytes).toBe(Buffer.byteLength(content));
    expect(finalContent.trim().split("\n").map(line => JSON.parse(line).seq)).toEqual([1, 2, 3]);
    expect(final.initialSourceCursor).toBe(11);
    expect(final.initialSourcePrefixVerified).toBe(false);
  });

  it.each(["internal-deadline", "caller-abort"] as const)("distinguishes proof %s after the byte head committed", async kind => {
    const m = memory(), caller = new AbortController();
    const options = { provider: m.provider, keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async () => undefined };
    const store = createObjectRunLogStore(options), handle = await store.begin({ ...input, signal: caller.signal });
    await store.recordVerifiedSourcePrefix!(handle, 0);
    const put = m.provider.putObjectConditional!.bind(m.provider);
    const deadline = new AbortController();
    let entered!: () => void;
    const proofStarted = new Promise<void>(resolve => { entered = resolve; });
    m.provider.putObjectConditional = async value => {
      if (!value.objectKey.includes("/objects/source-prefix-proof-v1-")) return put(value);
      entered();
      return new Promise((_resolve, reject) => {
        if (value.signal!.aborted) reject(value.signal!.reason);
        else value.signal!.addEventListener("abort", () => reject(value.signal!.reason), { once: true });
      });
    };
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let first: unknown;
    const callerReason = new Error("caller revoked writer");
    try {
      const pending = store.append(handle, { ...event(1), sourceCursor: 2, preservesSourceCoverage: true })
        .catch(error => error);
      await proofStarted;
      if (kind === "internal-deadline") deadline.abort(new DOMException("proof deadline", "TimeoutError"));
      else caller.abort(callerReason);
      first = await pending;
    } finally { timeout.mockRestore(); m.provider.putObjectConditional = put; }
    const second = await store.append(handle, { ...event(2), sourceCursor: 5, preservesSourceCoverage: true })
      .catch(error => error);
    const summary = await store.finalize(handle);
    const cold = createObjectRunLogStore(options), resumed = await cold.begin(input);
    await cold.finalize(resumed);
    expect(resumed.initialSourcePrefixVerified).toBe(false);
    if (kind === "internal-deadline") {
      expect(first).toBeTypeOf("number");
      expect(second).toBeTypeOf("number");
      expect(summary.bytes).not.toBeNull();
      expect(resumed.initialSourceCursor).toBe(5);
    } else {
      expect(first).toBe(callerReason);
      expect(second).toBe(callerReason);
      expect(summary.bytes).toBeNull();
      expect(resumed.initialSourceCursor).toBe(2);
    }
  });

  it("keeps an unknown head publication failure fatal", async () => {
    const m = memory(), store = createObjectRunLogStore({ provider: m.provider, keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async () => undefined });
    const handle = await store.begin(input);
    await store.recordVerifiedSourcePrefix!(handle, 0);
    const put = m.provider.putObjectConditional!.bind(m.provider);
    m.provider.putObjectConditional = async value => {
      if (value.objectKey.endsWith("/head.json")) throw new Error("unknown head publication failure");
      return put(value);
    };
    await expect(store.append(handle, { ...event(1), sourceCursor: 2, preservesSourceCoverage: true }))
      .rejects.toThrow("unknown head publication failure");
    await expect(store.append(handle, { ...event(2), sourceCursor: 5, preservesSourceCoverage: true }))
      .rejects.toThrow("unknown head publication failure");
    expect((await store.read(handle)).content).toBe("");
    await store.finalize(handle);
  });

  it("binds source proof to exact immutable bytes and invalidates it on ordinary appends", async () => {
    const m = memory(), options = { provider: m.provider, keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async () => undefined };
    const store = createObjectRunLogStore(options), handle = await store.begin(input);
    expect(handle.initialSourcePrefixVerified).toBe(false);
    await store.recordVerifiedSourcePrefix!(handle, 0);
    await store.append(handle, { ...event(1), sourceCursor: 2, preservesSourceCoverage: true });
    await store.finalize(handle);
    const replacement = createObjectRunLogStore(options), verified = await replacement.begin(input);
    expect(verified.initialSourceCursor).toBe(2);
    expect(verified.initialSourcePrefixVerified).toBe(true);
    const head = JSON.parse([...m.objects].find(([key]) => key.endsWith("/head.json"))![1].toString());
    expect(Object.keys(head).sort()).toEqual([
      "cleanupAfter", "closed", "deleted", "end", "generation", "owner", "root", "roots", "sequence", "sourceCursor", "v",
    ]);
    // An older/generic caller cannot carry the attestation across new bytes,
    // even when it reuses the old max cursor or calls its payload a diagnostic.
    await replacement.append(verified, { ...event(2), sourceCursor: 2,
      chunk: '{"type":"paperclip.prp.event","event":{"duplicate":true}}' });
    await replacement.finalize(verified);
    const legacy = await store.begin(input);
    expect(legacy.initialSourceCursor).toBe(2);
    expect(legacy.initialSourcePrefixVerified).toBe(false);
    await store.finalize(legacy);
  });

  it("fails closed when an existing exact-prefix proof is malformed or changed", async () => {
    const m = memory(), options = { provider: m.provider, keyPrefix: "logs", flushMs: 1,
      assertWriterAuthority: async () => undefined };
    const store = createObjectRunLogStore(options), handle = await store.begin(input);
    await store.recordVerifiedSourcePrefix!(handle, 0);
    await store.append(handle, { ...event(1), sourceCursor: 2, preservesSourceCoverage: true });
    await store.finalize(handle);
    const proofs = [...m.objects.keys()].filter(key => key.includes("/objects/source-prefix-proof-v1-"));
    expect(proofs.length).toBeGreaterThan(0);
    for (const key of proofs) m.objects.set(key, Buffer.from('{"schema":"changed-proof"}'));
    await expect(createObjectRunLogStore(options).begin(input))
      .rejects.toThrow("object_journal_source_prefix_proof_invalid");
  });

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
