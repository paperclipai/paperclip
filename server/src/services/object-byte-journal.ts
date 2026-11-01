import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import type { StorageProvider } from "../storage/types.js";

const MAX_INDEX_LEVEL = 52;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const offset = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const referenceSchema = z
  .object({
    key: z.string(),
    start: offset,
    end: offset,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
type Reference = z.infer<typeof referenceSchema>;
const nodeSchema = z
  .object({
    level: z.number().int().min(0).max(MAX_INDEX_LEVEL),
    children: z.array(referenceSchema).min(1).max(64),
  })
  .strict();
type Node = z.infer<typeof nodeSchema>;
const rootSchema = referenceSchema.extend({ level: z.number().int().min(0).max(MAX_INDEX_LEVEL) });
type Root = z.infer<typeof rootSchema>;
const headSchema = z
  .object({
    v: z.literal(1),
    owner: z.string().uuid(),
    generation: offset,
    end: offset,
    sequence: offset.default(0),
    sourceCursor: offset.default(0),
    root: referenceSchema.nullable(),
    roots: z
      .array(rootSchema)
      .max(MAX_INDEX_LEVEL + 1)
      .optional(),
    closed: z.boolean(),
    deleted: z.boolean(),
    cleanupAfter: offset.default(0),
  })
  .strict();
export type ObjectJournalHead = z.infer<typeof headSchema>;
export interface ObjectJournalWriter {
  head: ObjectJournalHead;
  etag: string;
}
export class ObjectJournalConflictError extends Error {
  readonly code = "object_journal_writer_conflict";
  constructor() {
    super("The output journal is owned by another writer");
  }
}
export function isObjectPreconditionFailure(error: unknown) {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "PreconditionFailed" || e?.$metadata?.httpStatusCode === 412;
}
function isRetryable(error: unknown) {
  const e = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = e?.$metadata?.httpStatusCode;
  return (
    e?.name === "ConditionalRequestConflict" ||
    status === 409 ||
    status === 429 ||
    (status !== undefined && status >= 500) ||
    ["TimeoutError", "RequestTimeout", "NetworkingError"].includes(e?.name ?? "") ||
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE"].includes(e?.code ?? "")
  );
}
async function retryObjectOperation<T>(operation: () => Promise<T>, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2 || !isRetryable(error)) throw error;
      await delay(100 * 2 ** attempt, undefined, { signal });
    }
  }
}
function isMissing(error: unknown) {
  const e = error as { name?: string; status?: number; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "NoSuchKey" ||
    e?.name === "NotFound" ||
    e?.status === 404 ||
    e?.$metadata?.httpStatusCode === 404
  );
}
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
interface ConditionalQualification {
  work: Promise<void>;
  controller: AbortController;
  waiters: number;
}
const qualifiedProviders = new WeakSet<StorageProvider>();
const qualifications = new WeakMap<StorageProvider, ConditionalQualification>();
async function qualifyConditionalWrites(
  provider: StorageProvider,
  prefix: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (qualifiedProviders.has(provider)) return;
  let qualification = qualifications.get(provider);
  if (!qualification || qualification.controller.signal.aborted) {
    const controller = new AbortController();
    const probeSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    const current: ConditionalQualification = { controller, waiters: 0, work: Promise.resolve() };
    qualification = current;
    current.work = (async () => {
      const objectKey = `${prefix}/conditional-probe-${randomUUID()}`;
      const body = Buffer.from("paperclip-conditional-probe-v1");
      const put = provider.putObjectConditional!.bind(provider);
      try {
        await retryObjectOperation(
          () =>
            put({
              objectKey,
              body,
              contentLength: body.length,
              contentType: "text/plain",
              ifNoneMatch: "*",
              signal: probeSignal,
            }),
          probeSignal,
        );
        for (const condition of [
          { ifNoneMatch: "*" as const },
          { ifMatch: '"paperclip-impossible-etag"' },
        ]) {
          let rejected = false;
          try {
            await retryObjectOperation(
              () =>
                put({
                  objectKey,
                  body,
                  contentLength: body.length,
                  contentType: "text/plain",
                  ...condition,
                  signal: probeSignal,
                }),
              probeSignal,
            );
          } catch (error) {
            if (!isObjectPreconditionFailure(error)) throw error;
            rejected = true;
          }
          if (!rejected) throw new Error("Object storage does not enforce conditional publication");
        }
      } finally {
        await provider.deleteObject({ objectKey, signal: probeSignal });
      }
      probeSignal.throwIfAborted();
      qualifiedProviders.add(provider);
    })().finally(() => {
      if (qualifications.get(provider) === current) qualifications.delete(provider);
    });
    qualifications.set(provider, current);
    void current.work.catch(() => undefined);
  }
  const pending = qualification;
  pending.waiters++;
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return false;
      finished = true;
      signal?.removeEventListener("abort", abort);
      pending.waiters--;
      return true;
    };
    const abort = () => {
      if (!release()) return;
      if (!pending.waiters) {
        pending.controller.abort(signal!.reason);
        void pending.work.then(
          () => reject(signal!.reason),
          () => reject(signal!.reason),
        );
      } else reject(signal!.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    pending.work.then(
      () => {
        if (release()) resolve();
      },
      (error) => {
        if (release()) reject(error);
      },
    );
  });
}

let activeIO = 0;
const waitingIO: Array<() => void> = [];
async function objectIO<T>(operation: () => Promise<T>): Promise<T> {
  if (activeIO >= 8) {
    if (waitingIO.length >= 32) throw new Error("object_journal_io_capacity_exceeded");
    await new Promise<void>((resolve) => waitingIO.push(resolve));
  } else activeIO++;
  try {
    return await operation();
  } finally {
    const next = waitingIO.shift();
    if (next) next();
    else activeIO--;
  }
}

export interface ObjectByteJournalOptions {
  provider: StorageProvider;
  prefix: string;

  encode?: (bytes: Buffer) => Promise<Buffer>;
  decode?: (bytes: Buffer) => Promise<Buffer>;
}

export function createObjectByteJournal(options: ObjectByteJournalOptions) {
  const { provider } = options;
  const prefix = options.prefix.replace(/\/+$/, "");
  if (
    !prefix ||
    prefix.length > 512 ||
    prefix.startsWith("/") ||
    prefix.split("/").some((p) => !/^[a-zA-Z0-9._-]+$/.test(p))
  ) {
    throw new Error("invalid_object_journal_prefix");
  }
  if (!provider.putObjectConditional || !provider.listObjects)
    throw new Error("Object storage requires conditional writes and scoped listing");
  const headKey = `${prefix}/head.json`;
  const objectPrefix = `${prefix}/objects/`;
  const putConditional = (
    input: Parameters<NonNullable<StorageProvider["putObjectConditional"]>>[0],
  ) => objectIO(() => provider.putObjectConditional!(input));

  async function getBytes(key: string, limit: number, signal?: AbortSignal) {
    return objectIO(async () => {
      signal?.throwIfAborted();
      signal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000);
      const result = await retryObjectOperation(
        () => provider.getObject({ objectKey: key, signal }),
        signal,
      );
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of result.stream) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > limit) throw new Error("object_journal_object_too_large");
          chunks.push(bytes);
        }
      } finally {
        result.stream.destroy();
      }
      signal?.throwIfAborted();
      return { bytes: Buffer.concat(chunks), etag: result.etag };
    });
  }
  async function head(signal?: AbortSignal): Promise<ObjectJournalWriter | null> {
    let result;
    try {
      result = await getBytes(headKey, 64 * 1024, signal);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    if (!result.etag) throw new Error("object_journal_missing_etag");
    const value = headSchema.parse(JSON.parse(result.bytes.toString("utf8")));
    if (value.roots) {
      let end = 0,
        level = MAX_INDEX_LEVEL + 1;
      if (value.root) throw new Error("object_journal_invalid_head");
      for (const root of value.roots) {
        validateReference(root);
        if (root.start !== end || root.level >= level)
          throw new Error("object_journal_invalid_head");
        end = root.end;
        level = root.level;
      }
      if (end !== value.end) throw new Error("object_journal_invalid_head");
    } else if ((value.root?.end ?? 0) !== value.end || (value.root && value.root.start !== 0)) {
      throw new Error("object_journal_invalid_head");
    }
    return { head: value, etag: result.etag };
  }
  async function publish(value: ObjectJournalHead, etag: string | null, signal?: AbortSignal) {
    value = headSchema.parse(value);
    signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    const bytes = Buffer.from(JSON.stringify(value));
    return retryObjectOperation(async () => {
      try {
        const result = await putConditional({
          objectKey: headKey,
          body: bytes,
          contentLength: bytes.length,
          contentType: "application/json",
          signal,
          ...(etag ? { ifMatch: etag } : { ifNoneMatch: "*" as const }),
        });
        return { head: value, etag: result.etag };
      } catch (error) {
        const observed = await head(signal);
        if (observed && JSON.stringify(observed.head) === JSON.stringify(value)) return observed;
        if (isObjectPreconditionFailure(error) || (observed?.etag ?? null) !== etag)
          throw new ObjectJournalConflictError();
        throw error;
      }
    }, signal);
  }
  async function claim(input: {
    expectedOwner: string | null;
    assertAuthority: () => Promise<void>;
    signal?: AbortSignal;
  }) {
    const current = await head(input.signal);
    if (current?.head.deleted || (current?.head.owner ?? null) !== input.expectedOwner)
      throw new ObjectJournalConflictError();
    await input.assertAuthority();
    await qualifyConditionalWrites(provider, prefix, input.signal);
    await input.assertAuthority();
    const value: ObjectJournalHead = {
      v: 1,
      owner: randomUUID(),
      generation: (current?.head.generation ?? 0) + 1,
      end: current?.head.end ?? 0,
      sequence: current?.head.sequence ?? 0,
      sourceCursor: current?.head.sourceCursor ?? 0,
      root: current?.head.root ?? null,
      ...(current?.head.roots ? { roots: current.head.roots } : {}),
      closed: false,
      deleted: false,
      cleanupAfter: 0,
    };
    return publish(value, current?.etag ?? null, input.signal);
  }
  function validateReference(ref: Reference) {
    if (
      !ref.key.startsWith(objectPrefix) ||
      ref.key !== `${objectPrefix}${ref.sha256}` ||
      ref.end <= ref.start
    )
      throw new Error("object_journal_invalid_reference");
  }
  async function load(ref: Reference, signal?: AbortSignal) {
    validateReference(ref);
    const stored = await getBytes(ref.key, MAX_OBJECT_BYTES * 2, signal);
    const bytes = options.decode ? await options.decode(stored.bytes) : stored.bytes;
    if (bytes.length > MAX_OBJECT_BYTES || sha256(bytes) !== ref.sha256)
      throw new Error("object_journal_integrity_error");
    return bytes;
  }
  async function save(
    bytes: Buffer,
    start: number,
    end: number,
    signal?: AbortSignal,
  ): Promise<Reference> {
    if (bytes.length > MAX_OBJECT_BYTES) throw new Error("object_journal_segment_too_large");
    signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    const digest = sha256(bytes),
      key = `${objectPrefix}${digest}`;
    const body = options.encode ? await options.encode(bytes) : bytes;
    try {
      await retryObjectOperation(
        () =>
          putConditional({
            objectKey: key,
            body,
            contentLength: body.length,
            contentType: "application/octet-stream",
            ifNoneMatch: "*",
            signal,
          }),
        signal,
      );
    } catch (error) {
      const ref = { key, sha256: digest, start, end };
      try {
        await load(ref, signal);
      } catch {
        throw error;
      }
    }
    return { key, start, end, sha256: digest };
  }
  async function loadNode(ref: Reference, signal?: AbortSignal): Promise<Node> {
    const node = nodeSchema.parse(JSON.parse((await load(ref, signal)).toString("utf8")));
    let next = ref.start;
    for (const child of node.children) {
      validateReference(child);
      if (child.start !== next) throw new Error("object_journal_noncontiguous_index");
      next = child.end;
    }
    if (next !== ref.end) throw new Error("object_journal_invalid_index_range");
    return node;
  }
  const saveNode = (node: Node, signal?: AbortSignal) =>
    save(
      Buffer.from(JSON.stringify(node)),
      node.children[0]!.start,
      node.children.at(-1)!.end,
      signal,
    );
  async function readRange(
    snapshot: ObjectJournalHead,
    start: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (snapshot.deleted) throw new Error("object_journal_deleted");
    if (
      !Number.isSafeInteger(start) ||
      start < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 0 ||
      limit > MAX_OBJECT_BYTES
    )
      throw new Error("invalid_object_journal_range");
    if ((!snapshot.root && !snapshot.roots?.length) || limit === 0 || start >= snapshot.end)
      return Buffer.alloc(0);
    const end = Math.min(snapshot.end, start + limit),
      chunks: Buffer[] = [];
    async function readPayload(ref: Reference) {
      const bytes = await load(ref, signal);
      if (bytes.length !== ref.end - ref.start)
        throw new Error("object_journal_invalid_segment_length");
      chunks.push(
        bytes.subarray(Math.max(0, start - ref.start), Math.min(bytes.length, end - ref.start)),
      );
    }
    async function visit(ref: Reference, expectedLevel?: number) {
      const node = await loadNode(ref, signal);
      if (expectedLevel !== undefined && node.level !== expectedLevel)
        throw new Error("object_journal_invalid_index_level");
      for (const child of node.children) {
        if (child.end <= start || child.start >= end) continue;
        if (node.level > 0) await visit(child, node.level - 1);
        else await readPayload(child);
      }
    }
    if (snapshot.roots) {
      for (const root of snapshot.roots) {
        if (root.end <= start || root.start >= end) continue;
        if (root.level === 0) await readPayload(root);
        else await visit(root, root.level - 1);
      }
    } else if (snapshot.root) await visit(snapshot.root);
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== end - start) throw new Error("object_journal_missing_range");
    return bytes;
  }
  async function append(
    writer: ObjectJournalWriter,
    bytes: Buffer,
    signal?: AbortSignal,
    sequence = writer.head.sequence,
    sourceCursor = writer.head.sourceCursor,
  ) {
    signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000);
    if (writer.head.closed || writer.head.deleted) throw new ObjectJournalConflictError();
    if (bytes.length === 0) return writer;
    if (
      bytes.length > 8 * 1024 * 1024 ||
      !Number.isSafeInteger(writer.head.end + bytes.length) ||
      !Number.isSafeInteger(sequence) ||
      sequence < writer.head.sequence ||
      !Number.isSafeInteger(sourceCursor) ||
      sourceCursor < writer.head.sourceCursor
    )
      throw new Error("object_journal_invalid_batch");
    const roots: Root[] = writer.head.roots
      ? [...writer.head.roots]
      : writer.head.root
        ? [{ ...writer.head.root, level: (await loadNode(writer.head.root, signal)).level + 1 }]
        : [];
    let end = writer.head.end;
    for (let start = 0; start < bytes.length; start += 1024 * 1024) {
      const part = bytes.subarray(start, start + 1024 * 1024);
      let root: Root = { ...(await save(part, end, end + part.length, signal)), level: 0 };
      end = root.end;
      while (roots.at(-1)?.level === root.level) {
        const left = roots.pop()!;
        const { level: leftLevel, ...leftRef } = left;
        const { level, ...rightRef } = root;
        if (level >= MAX_INDEX_LEVEL || leftLevel !== level)
          throw new Error("object_journal_index_capacity_exceeded");
        root = {
          ...(await saveNode({ level, children: [leftRef, rightRef] }, signal)),
          level: level + 1,
        };
      }
      roots.push(root);
    }
    return publish(
      { ...writer.head, end, root: null, roots, sequence, sourceCursor },
      writer.etag,
      signal,
    );
  }

  async function close(writer: ObjectJournalWriter, signal?: AbortSignal) {
    return publish({ ...writer.head, closed: true }, writer.etag, signal);
  }
  async function remove(signal?: AbortSignal) {
    let tombstone: ObjectJournalWriter | undefined;
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await head(signal);
      if (current?.head.deleted) {
        tombstone = current;
        break;
      }
      const value: ObjectJournalHead = current
        ? {
            ...current.head,
            deleted: true,
            closed: true,
            cleanupAfter: current.head.closed ? 0 : Date.now() + 30_000,
          }
        : {
            v: 1,
            sourceCursor: 0,
            owner: randomUUID(),
            generation: 0,
            end: 0,
            sequence: 0,
            root: null,
            deleted: true,
            closed: true,
            cleanupAfter: 0,
          };
      try {
        tombstone = await publish(value, current?.etag ?? null, signal);
        break;
      } catch (error) {
        if (!(error instanceof ObjectJournalConflictError)) throw error;
      }
    }
    if (!tombstone) throw new ObjectJournalConflictError();
    if (tombstone.head.cleanupAfter > Date.now()) throw new Error("object_journal_cleanup_pending");

    let continuationToken: string | undefined;
    do {
      const deadline = () =>
        signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
          : AbortSignal.timeout(15_000);
      const page = await objectIO(() =>
        provider.listObjects!({ prefix: objectPrefix, continuationToken, signal: deadline() }),
      );
      for (const key of page.keys) {
        if (!key.startsWith(objectPrefix)) throw new Error("object_journal_invalid_listing");
        await objectIO(() => provider.deleteObject({ objectKey: key, signal: deadline() }));
      }
      continuationToken = page.continuationToken;
    } while (continuationToken);
  }
  return { head, claim, append, close, readRange, remove };
}
export type ObjectByteJournal = ReturnType<typeof createObjectByteJournal>;
