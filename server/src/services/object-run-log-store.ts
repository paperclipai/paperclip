import { beginIdleTrackedWork } from "./task-admission.js";
import { createHash, randomUUID } from "node:crypto";
import type { StorageProvider } from "../storage/types.js";
import type { RunLogStore, RunLogHandle, RunLogBeginInput } from "./run-log-store.js";
import { createObjectByteJournal, type ObjectJournalWriter } from "./object-byte-journal.js";

const MAX_SEGMENT_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 8 * MAX_SEGMENT_BYTES;
const MAX_READ_BYTES = 4 * MAX_SEGMENT_BYTES;
export interface ObjectRunLogStoreOptions {
  provider: StorageProvider;
  keyPrefix: string;
  flushMs?: number;
  segmentBytes?: number;

  assertWriterAuthority: (input: RunLogBeginInput) => Promise<void>;
}
interface PendingAppend {
  bytes: Buffer;
  sequence: number;
  resolve: (bytes: number) => void;
  reject: (error: unknown) => void;
}
interface WriterState {
  journal: ReturnType<typeof createObjectByteJournal>;
  writer: ObjectJournalWriter;
  pending: PendingAppend[];
  pendingBytes: number;
  timer?: NodeJS.Timeout;
  flushing?: Promise<void>;
  closed: boolean;
  failure?: unknown;
}

export function createObjectRunLogStore(options: ObjectRunLogStoreOptions): RunLogStore {
  const flushMs = options.flushMs ?? 1000;
  const segmentBytes = options.segmentBytes ?? MAX_SEGMENT_BYTES;
  if (
    !Number.isSafeInteger(flushMs) ||
    flushMs < 1 ||
    flushMs > 30_000 ||
    !Number.isSafeInteger(segmentBytes) ||
    segmentBytes < 1024 ||
    segmentBytes > MAX_SEGMENT_BYTES
  )
    throw new Error("Invalid object log batching limits");
  const writers = new Map<RunLogHandle, WriterState>();
  let totalPendingBytes = 0;
  let activeUploads = 0;
  const uploadWaiters: Array<() => void> = [];
  async function acquireUpload() {
    if (activeUploads >= 4) await new Promise<void>((resolve) => uploadWaiters.push(resolve));
    else activeUploads++;
    return () => {
      const next = uploadWaiters.shift();
      if (next) next();
      else activeUploads--;
    };
  }
  function journal(logRef: string) {
    if (!/^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(logRef))
      throw new Error("Invalid object log reference");
    return createObjectByteJournal({
      provider: options.provider,
      prefix: `${options.keyPrefix}/segments-v1/${logRef}`,
    });
  }
  function schedule(state: WriterState) {
    if (state.closed || state.failure || state.timer || state.flushing || !state.pending.length)
      return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      void flush(state).catch(() => undefined);
    }, flushMs);
  }
  async function flush(state: WriterState): Promise<void> {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.flushing) {
      await state.flushing;
      if (state.pending.length) return flush(state);
      return;
    }
    if (state.failure) throw state.failure;
    if (!state.pending.length) return;
    const batch = state.pending.splice(0);
    const bytes = Buffer.concat(batch.map((p) => p.bytes));
    state.flushing = (async () => {
      const release = await acquireUpload();
      try {
        state.writer = await state.journal.append(
          state.writer,
          bytes,
          undefined,
          Math.max(state.writer.head.sequence, ...batch.map((p) => p.sequence)),
        );
        for (const item of batch) item.resolve(item.bytes.length);
      } catch (error) {
        state.failure = error;
        const waiting = state.pending.splice(0);
        const waitingBytes = waiting.reduce((sum, item) => sum + item.bytes.length, 0);
        state.pendingBytes -= waitingBytes;
        totalPendingBytes -= waitingBytes;
        for (const item of [...batch, ...waiting]) item.reject(error);
        throw error;
      } finally {
        state.pendingBytes -= bytes.length;
        totalPendingBytes -= bytes.length;
        release();
        state.flushing = undefined;
        schedule(state);
      }
    })();
    await state.flushing;
  }
  return {
    async begin(input) {
      const logRef = `${input.companyId}/${input.agentId}/${input.runId}`;
      const store = journal(logRef),
        current = await store.head();
      const writer = await store.claim({
        expectedOwner: current?.head.owner ?? null,
        assertAuthority: () => options.assertWriterAuthority(input),
      });
      const handle: RunLogHandle = {
        store: "s3_segments",
        logRef,
        attemptId: randomUUID(),
        initialBytes: writer.head.end,
        initialSequence: writer.head.sequence,
      };
      writers.set(handle, { journal: store, writer, pending: [], pendingBytes: 0, closed: false });
      return handle;
    },
    async append(handle, event) {
      const state = writers.get(handle);
      if (!state || state.closed) throw new Error("Object run log writer is closed");
      if (state.failure) throw state.failure;
      const bytes = Buffer.from(
        `${JSON.stringify({
          ts: event.ts,
          attemptId: handle.attemptId,
          stream: event.stream,
          chunk: event.chunk,
          ...(event.seq === undefined ? {} : { seq: event.seq }),
        })}\n`,
      );
      if (
        state.pendingBytes + bytes.length > MAX_PENDING_BYTES ||
        totalPendingBytes + bytes.length > 64 * MAX_SEGMENT_BYTES
      ) {
        const error = new Error("Object run log pending-byte limit exceeded");
        state.failure = error;
        if (state.timer) {
          clearTimeout(state.timer);
          state.timer = undefined;
        }
        const waiting = state.pending.splice(0);
        const size = waiting.reduce((sum, item) => sum + item.bytes.length, 0);
        state.pendingBytes -= size;
        totalPendingBytes -= size;
        for (const item of waiting) item.reject(error);
        throw error;
      }
      state.pendingBytes += bytes.length;
      totalPendingBytes += bytes.length;
      const finishIdle = beginIdleTrackedWork();
      const committed = new Promise<number>((resolve, reject) =>
        state.pending.push({
          bytes,
          sequence: event.seq ?? state.writer.head.sequence,
          resolve,
          reject,
        }),
      ).finally(finishIdle);
      if (state.pendingBytes >= segmentBytes) void flush(state).catch(() => undefined);
      else schedule(state);
      return committed;
    },
    async finalize(handle) {
      const state = writers.get(handle);
      if (!state) throw new Error("Object run log writer not found");
      state.closed = true;
      try {
        await flush(state);
        state.writer = await state.journal.close(state.writer);
        const hash = createHash("sha256");
        for (let start = 0; start < state.writer.head.end; start += MAX_READ_BYTES) {
          hash.update(await state.journal.readRange(state.writer.head, start, MAX_READ_BYTES));
        }
        return { bytes: state.writer.head.end, sha256: hash.digest("hex"), compressed: false };
      } catch {
        process.emitWarning(
          "Run log persistence is incomplete; final size and digest are unknown.",
        );
        return { bytes: null, sha256: null, compressed: false };
      } finally {
        writers.delete(handle);
      }
    },
    async read(handle, opts = {}) {
      if (handle.store !== "s3_segments") throw new Error("Invalid object run log backend");
      const store = journal(handle.logRef),
        snapshot = await store.head(opts.signal);
      if (!snapshot || snapshot.head.deleted) throw new Error("Object run log not found");
      const offset = Math.max(0, opts.offset ?? 0),
        limit = opts.limitBytes ?? 256_000;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_BYTES)
        throw new Error("Invalid object log read limit");
      const fetched = await store.readRange(
        snapshot.head,
        offset,
        Math.min(MAX_READ_BYTES, limit + 3),
        opts.signal,
      );
      let end = Math.min(limit, fetched.length);
      while (end < fetched.length && (fetched[end]! & 0xc0) === 0x80) end++;
      if (
        end === fetched.length &&
        offset + end < snapshot.head.end &&
        fetched.length === MAX_READ_BYTES
      ) {
        let lead = end - 1;
        while (lead >= 0 && (fetched[lead]! & 0xc0) === 0x80) lead--;
        const first = fetched[lead] ?? 0;
        const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
        if (end - lead < width) end = lead;
      }
      const bytes = fetched.subarray(0, end);
      const nextOffset =
        offset + bytes.length < snapshot.head.end ? offset + bytes.length : undefined;
      if (!opts.alignStartToRecord || offset === 0 || bytes.length === 0)
        return { content: bytes.toString("utf8"), nextOffset };
      const parts = [bytes];
      let before = offset;

      while (before > 0) {
        const start = Math.max(0, before - 32_000);
        const prefix = await store.readRange(snapshot.head, start, before - start, opts.signal);
        const boundary = prefix.lastIndexOf(10);
        parts.unshift(prefix.subarray(boundary + 1));
        if (boundary >= 0) break;
        before = start;
        if (parts.reduce((n, part) => n + part.length, 0) > MAX_PENDING_BYTES)
          throw new Error("Object log record exceeds read alignment limit");
      }
      return {
        content: Buffer.concat(parts).toString("utf8"),
        nextOffset: nextOffset ?? offset + bytes.length,
      };
    },
    async flushInflightMirrors() {
      await Promise.all([...writers.values()].map(flush));
    },
  };
}
