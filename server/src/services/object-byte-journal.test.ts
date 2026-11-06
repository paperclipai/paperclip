import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageProvider } from "../storage/types.js";
import { createObjectByteJournal, ObjectJournalConflictError } from "./object-byte-journal.js";

async function readBody(body: AsyncIterable<Uint8Array>) {
  const chunks: Buffer[] = [];
  for await (const bytes of body) chunks.push(Buffer.from(bytes));
  return Buffer.concat(chunks);
}

function storage() {
  const objects = new Map<string, Buffer>();
  const calls = { get: 0, put: 0, maxPut: 0 };
  let loseHeadResponse = false;
  const etag = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const missing = () => Object.assign(new Error("missing"), { name: "NoSuchKey" });
  const conflict = () => Object.assign(new Error("conflict"), { name: "PreconditionFailed" });
  const provider: StorageProvider = {
    id: "s3",
    async getObject({ objectKey, signal }) {
      signal?.throwIfAborted();
      calls.get++;
      const bytes = objects.get(objectKey);
      if (!bytes) throw missing();
      return { stream: Readable.from([bytes]), etag: etag(bytes), contentLength: bytes.length };
    },
    async putObject() {
      throw new Error("unconditional PUT forbidden");
    },
    async putObjectConditional(input) {
      const old = objects.get(input.objectKey);
      if (input.ifNoneMatch ? old : !old || etag(old) !== input.ifMatch) throw conflict();
      const bytes = Buffer.isBuffer(input.body) ? input.body : await readBody(input.body);
      objects.set(input.objectKey, Buffer.from(bytes));
      calls.put++;
      calls.maxPut = Math.max(calls.maxPut, bytes.length);
      if (loseHeadResponse && input.objectKey.endsWith("/head.json")) {
        loseHeadResponse = false;
        throw new Error("response lost after PUT");
      }
      return { etag: etag(bytes) };
    },
    async headObject({ objectKey }) {
      return { exists: objects.has(objectKey) };
    },
    async deleteObject({ objectKey }) {
      objects.delete(objectKey);
    },
    async listObjects({ prefix }) {
      return { keys: [...objects.keys()].filter((k) => k.startsWith(prefix)) };
    },
  };
  return {
    provider,
    objects,
    calls,
    loseResponse: () => {
      loseHeadResponse = true;
    },
  };
}
const authority = async () => undefined;
afterEach(() => vi.useRealTimers());

describe("object byte journal", () => {
  it("keeps a shared capability probe alive for another writer when one claim cancels", async () => {
    const s = storage();
    const put = s.provider.putObjectConditional!;
    let release!: () => void, started!: () => void, admitted!: () => void;
    let probeSignal: AbortSignal | undefined;
    const probing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const joined = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    s.provider.putObjectConditional = async (input) => {
      if (input.objectKey.includes("conditional-probe-") && !probeSignal) {
        probeSignal = input.signal;
        await new Promise<void>((resolve, reject) => {
          release = resolve;
          input.signal!.addEventListener("abort", () => reject(input.signal!.reason), {
            once: true,
          });
          started();
        });
      }
      return put(input);
    };
    const controller = new AbortController();
    const a = createObjectByteJournal({ provider: s.provider, prefix: "company/a/log" });
    const first = a.claim({
      expectedOwner: null,
      assertAuthority: authority,
      signal: controller.signal,
    });
    void first.catch(() => undefined);
    await probing;
    const b = createObjectByteJournal({ provider: s.provider, prefix: "company/b/log" });
    const second = b.claim({
      expectedOwner: null,
      assertAuthority: async () => {
        admitted();
      },
    });
    await joined;
    await Promise.resolve();
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(probeSignal!.aborted).toBe(false);
    release();
    const writer = await second;
    expect((await b.head())!.head.owner).toBe(writer.head.owner);
  });
  it("recovers committed bytes and stable ranges with no local filesystem", async () => {
    const s = storage(),
      a = createObjectByteJournal({ provider: s.provider, prefix: "company/run/log" });
    let writer = await a.claim({ expectedOwner: null, assertAuthority: authority });
    const expected = Buffer.from("first\n再開\n".repeat(20));
    writer = await a.append(writer, expected.subarray(0, 17));
    writer = await a.append(writer, expected.subarray(17));
    const b = createObjectByteJournal({ provider: s.provider, prefix: "company/run/log" });
    const snapshot = (await b.head())!;
    expect(await b.readRange(snapshot.head, 0, expected.length)).toEqual(expected);
    expect(await b.readRange(snapshot.head, 7, 23)).toEqual(expected.subarray(7, 30));
    expect(await b.readRange(snapshot.head, expected.length, 100)).toEqual(Buffer.alloc(0));
  });
  it("fences stale appends/finalization and preserves a pinned reader snapshot", async () => {
    const s = storage(),
      a = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let old = await a.claim({ expectedOwner: null, assertAuthority: authority });
    old = await a.append(old, Buffer.from("before"));
    const snapshot = old.head;
    let next = await a.claim({ expectedOwner: old.head.owner, assertAuthority: authority });
    next = await a.append(next, Buffer.from("after"));
    await expect(a.append(old, Buffer.from("lost"))).rejects.toBeInstanceOf(
      ObjectJournalConflictError,
    );
    await expect(a.close(old)).rejects.toBeInstanceOf(ObjectJournalConflictError);
    expect(await a.readRange(snapshot, 0, 100)).toEqual(Buffer.from("before"));
    expect(await a.readRange(next.head, 0, 100)).toEqual(Buffer.from("beforeafter"));
  });
  it("reconciles an uncertain manifest commit without duplicating output", async () => {
    const s = storage(),
      a = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let writer = await a.claim({ expectedOwner: null, assertAuthority: authority });
    s.loseResponse();
    writer = await a.append(writer, Buffer.from("once"));
    expect(writer.head.end).toBe(4);
    expect(await a.readRange((await a.head())!.head, 0, 100)).toEqual(Buffer.from("once"));
  });
  it("keeps index objects bounded over multiple tree levels", async () => {
    const s = storage(),
      a = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let writer = await a.claim({ expectedOwner: null, assertAuthority: authority });
    for (let i = 0; i < 180; i++)
      writer = await a.append(writer, Buffer.from(String(i).padStart(4, "0")));
    expect(await a.readRange(writer.head, 252, 16)).toEqual(Buffer.from("0063006400650066"));
    expect(await a.readRange(writer.head, 700, 20)).toEqual(Buffer.from("01750176017701780179"));
    expect(s.calls.maxPut).toBeLessThan(20_000);
    expect(s.calls.put).toBeLessThan(180 * 5);
    const reachable = new Set<string>();
    function visit(ref: { key: string }, level: number) {
      reachable.add(ref.key);
      if (level === 0) return;
      const node = JSON.parse(s.objects.get(ref.key)!.toString());
      for (const child of node.children) visit(child, level - 1);
    }
    for (const root of writer.head.roots!) visit(root, root.level);
    expect([...reachable].sort()).toEqual(
      [...s.objects.keys()].filter((key) => key.includes("/objects/")).sort(),
    );
  });
  it("retries a transient head conflict without fencing its current writer", async () => {
    const s = storage(),
      journal = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let writer = await journal.claim({ expectedOwner: null, assertAuthority: authority });
    const original = s.provider.putObjectConditional!;
    let conflicts = 0;
    s.provider.putObjectConditional = async (input) => {
      if (input.objectKey.endsWith("/head.json") && conflicts++ === 0)
        throw Object.assign(new Error("in-flight conflict"), {
          name: "ConditionalRequestConflict",
          $metadata: { httpStatusCode: 409 },
        });
      return original(input);
    };
    writer = await journal.append(writer, Buffer.from("once"));
    expect(await journal.readRange(writer.head, 0, 100)).toEqual(Buffer.from("once"));
    expect(conflicts).toBe(2);
  });
  it("does not accept a provider's 409 response as proof of conditional enforcement", async () => {
    const s = storage(),
      original = s.provider.putObjectConditional!;
    s.provider.putObjectConditional = async (input) => {
      if (s.objects.has(input.objectKey))
        throw Object.assign(new Error("conflict"), { $metadata: { httpStatusCode: 409 } });
      return original(input);
    };
    const journal = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    await expect(
      journal.claim({ expectedOwner: null, assertAuthority: authority }),
    ).rejects.toThrow("conflict");
    expect(s.objects.size).toBe(0);
  });
  it("retries transient segment failures and acknowledges exactly one batch", async () => {
    const s = storage(),
      journal = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let writer = await journal.claim({ expectedOwner: null, assertAuthority: authority });
    const original = s.provider.putObjectConditional!;
    let failures = 2;
    s.provider.putObjectConditional = async (input) => {
      if (input.objectKey.includes("/objects/") && failures-- > 0)
        throw Object.assign(new Error("temporary outage"), { $metadata: { httpStatusCode: 503 } });
      return original(input);
    };
    writer = await journal.append(writer, Buffer.from("one batch"));
    expect(await journal.readRange(writer.head, 0, 100)).toEqual(Buffer.from("one batch"));
  });
  it("rejects corrupt published data and cancelled reads", async () => {
    const s = storage(),
      a = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let writer = await a.claim({ expectedOwner: null, assertAuthority: authority });
    writer = await a.append(writer, Buffer.from("data"));
    const data = [...s.objects].find(([, bytes]) => bytes.toString() === "data")!;
    s.objects.set(data[0], Buffer.from("oops"));
    await expect(a.readRange(writer.head, 0, 4)).rejects.toThrow("integrity");
    await expect(a.readRange(writer.head, 0, 4, AbortSignal.abort())).rejects.toThrow();
  });
  it("retains a deletion tombstone and denies a subsequent claim", async () => {
    const s = storage(),
      a = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let writer = await a.claim({ expectedOwner: null, assertAuthority: authority });
    writer = await a.append(writer, Buffer.from("private"));
    await a.close(writer);
    await a.remove();
    expect([...s.objects.keys()]).toEqual(["c/r/log/head.json"]);
    expect((await a.head())!.head.deleted).toBe(true);
    await expect(
      a.claim({ expectedOwner: writer.head.owner, assertAuthority: authority }),
    ).rejects.toThrow();
  });
  it("does not claim ownership when execution authority rejects", async () => {
    const s = storage(),
      a = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    await expect(
      a.claim({
        expectedOwner: null,
        assertAuthority: async () => {
          throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(s.calls.put).toBe(0);
  });
  it("fences a pending first claim when deletion wins before journal creation", async () => {
    const s = storage(),
      journal = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = journal.claim({
      expectedOwner: null,
      assertAuthority: async () => {
        enter();
        await blocked;
      },
    });
    await entered;
    await journal.remove();
    release();
    await expect(pending).rejects.toBeInstanceOf(ObjectJournalConflictError);
    expect((await journal.head())!.head.deleted).toBe(true);
    expect([...s.objects.keys()]).toEqual(["c/r/log/head.json"]);
  });
  it("rejects a compatible provider which silently ignores conditional writes", async () => {
    const s = storage();
    s.provider.putObjectConditional = async (input) => {
      const bytes = Buffer.from(input.body as Buffer);
      s.objects.set(input.objectKey, bytes);
      return { etag: "ignored-condition" };
    };
    const journal = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    await expect(
      journal.claim({ expectedOwner: null, assertAuthority: authority }),
    ).rejects.toThrow("does not enforce conditional");
    expect(s.objects.size).toBe(0);
  });
  it("fences an active writer before cleanup and preserves the retry obligation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const s = storage(),
      journal = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    let writer = await journal.claim({ expectedOwner: null, assertAuthority: authority });
    writer = await journal.append(writer, Buffer.from("private"));
    await expect(journal.remove()).rejects.toThrow("cleanup_pending");
    expect((await journal.head())!.head.deleted).toBe(true);
    await expect(journal.append(writer, Buffer.from("late"))).rejects.toBeInstanceOf(
      ObjectJournalConflictError,
    );
    vi.setSystemTime(Date.now() + 30_001);
    await journal.remove();
    expect([...s.objects.keys()]).toEqual(["c/r/log/head.json"]);
  });
  it("does not publish a partial batch when a later segment fails", async () => {
    const s = storage(),
      journal = createObjectByteJournal({ provider: s.provider, prefix: "c/r/log" });
    const writer = await journal.claim({ expectedOwner: null, assertAuthority: authority });
    const original = s.provider.putObjectConditional!;
    const failed = Buffer.alloc(1024 * 1024, 2);
    const key = createHash("sha256").update(failed).digest("hex");
    s.provider.putObjectConditional = (input) => {
      if (input.objectKey.endsWith(key)) throw Error("second segment failed");
      return original(input);
    };
    await expect(
      journal.append(writer, Buffer.concat([Buffer.alloc(1024 * 1024, 1), failed])),
    ).rejects.toThrow("second segment failed");
    expect((await journal.head())!.head.end).toBe(0);
  });
});
