import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { beginIdleTrackedWork } from "./task-admission.js";
import { watch, type FSWatcher } from "node:fs";
import { promises as fs } from "node:fs";
import {
  createObjectByteJournal,
  type ObjectByteJournal,
  type ObjectJournalWriter,
} from "./object-byte-journal.js";
import { deriveLocalEncryptedInstanceSecret } from "../secrets/local-encrypted-provider.js";
import type { StorageProvider } from "../storage/types.js";

const CHUNK_BYTES = 1024 * 1024;
const MAX_CAPTURE_BYTES = 192 * CHUNK_BYTES;
const REF = /^s3-segments-v1:([a-zA-Z0-9-]+)\/([a-zA-Z0-9-]+)\/([a-f0-9-]+\.ndjson)$/;
export function objectProviderTraceRef(ref: string) {
  return REF.exec(ref);
}
export function importingProviderTraceRef(ref: string) {
  return ref.startsWith("s3-import-v1:")
    ? objectProviderTraceRef(ref.replace("s3-import-v1:", "s3-segments-v1:"))
    : null;
}
export function providerTraceCleanupRef(ref: string) {
  return objectProviderTraceRef(ref)
    ? ref
    : importingProviderTraceRef(ref)
      ? ref.replace("s3-import-v1:", "s3-segments-v1:")
      : null;
}
interface Channel {
  path: string;
  journal: ObjectByteJournal;
  writer: ObjectJournalWriter;
  watcher?: FSWatcher;
}
interface Capture {
  channels: Channel[];
  controller: AbortController;
  signal: AbortSignal;
  flush?: Promise<void>;
  timer?: NodeJS.Timeout;
  stopped: boolean;
  dirty: boolean;
  error?: unknown;
  finishIdle: () => void;
}

export function createProviderTraceObjectStore(
  provider: StorageProvider,
  prefix = "provider-traces",
) {
  deriveLocalEncryptedInstanceSecret("provider-trace:existing-key", process.env, {
    allowCreate: false,
  });
  const captures = new Map<string, Capture>();
  const openings = new Map<string, Promise<void>>();
  function schedule(capture: Capture) {
    if (capture.stopped || !capture.dirty || capture.timer || capture.flush || capture.error)
      return;
    capture.timer = setTimeout(() => {
      capture.timer = undefined;
      void sync(capture).catch(() => undefined);
    }, 1000);
    capture.timer.unref();
  }
  function channelsFor(ref: string, filePath = "") {
    const match = objectProviderTraceRef(ref);
    if (!match) throw new Error("invalid_object_trace_ref");
    return ["native", "rehydration"].map((channel, i) => {
      const root = `${prefix}/segments-v1/${match[1]}/${match[2]}/${match[3]}/${channel}`;
      const key = Buffer.from(
        deriveLocalEncryptedInstanceSecret(`provider-trace:${root}`, process.env, {
          allowCreate: false,
        }),
        "base64url",
      );
      const aad = Buffer.from(root);
      const journal = createObjectByteJournal({
        provider,
        prefix: root,
        async encode(bytes) {
          const iv = randomBytes(12),
            cipher = createCipheriv("aes-256-gcm", key, iv);
          cipher.setAAD(aad);
          const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
          return Buffer.concat([iv, cipher.getAuthTag(), body]);
        },
        async decode(bytes) {
          if (bytes.length < 28) throw new Error("invalid_encrypted_trace_object");
          const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
          cipher.setAAD(aad);
          cipher.setAuthTag(bytes.subarray(12, 28));
          return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]);
        },
      });
      return { journal, path: i === 0 ? filePath : `${filePath}.rehydration` };
    });
  }
  async function sync(capture: Capture) {
    if (capture.timer) {
      clearTimeout(capture.timer);
      capture.timer = undefined;
    }
    if (capture.flush) return capture.flush;
    capture.dirty = false;
    capture.flush = (async () => {
      for (const channel of capture.channels) {
        capture.signal.throwIfAborted();
        const file = await fs.open(channel.path, "r");
        try {
          const stat = await file.stat();
          if (stat.size > MAX_CAPTURE_BYTES || stat.size < channel.writer.head.end)
            throw new Error("provider_trace_capture_size_invalid");
          let offset = channel.writer.head.end;
          while (offset < stat.size) {
            const buffer = Buffer.alloc(Math.min(CHUNK_BYTES, stat.size - offset));
            const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
            if (bytesRead !== buffer.length) throw new Error("provider_trace_capture_changed");
            channel.writer = await channel.journal.append(channel.writer, buffer, capture.signal);
            offset += buffer.length;
          }
        } finally {
          await file.close();
        }
      }
    })()
      .catch((error) => {
        capture.error = error;
        throw error;
      })
      .finally(() => {
        capture.flush = undefined;
        schedule(capture);
      });
    return capture.flush;
  }
  async function open(
    ref: string,
    filePath: string,
    assertAuthority: () => Promise<void>,
    options: { restore?: boolean; signal?: AbortSignal } = {},
  ) {
    const existing = openings.get(ref);
    if (existing) return existing;
    const opening = openCapture(ref, filePath, assertAuthority, options).finally(() =>
      openings.delete(ref),
    );
    openings.set(ref, opening);
    await opening;
  }
  async function openCapture(
    ref: string,
    filePath: string,
    assertAuthority: () => Promise<void>,
    options: { restore?: boolean; signal?: AbortSignal } = {},
  ) {
    if (captures.has(ref)) return;
    const controller = new AbortController();
    const capture: Capture = {
      channels: [],
      controller,
      signal: options.signal
        ? AbortSignal.any([controller.signal, options.signal])
        : controller.signal,
      stopped: false,
      dirty: false,
      finishIdle: () => undefined,
    };
    try {
      for (const source of channelsFor(ref, filePath)) {
        capture.signal.throwIfAborted();
        const current = await source.journal.head(capture.signal);
        const writer = await source.journal.claim({
          expectedOwner: current?.head.owner ?? null,
          assertAuthority,
          signal: capture.signal,
        });
        capture.channels.push({ ...source, writer });
        const file = await fs.open(source.path, options.restore === false ? "a+" : "w", 0o600);
        try {
          await file.chmod(0o600);
          for (
            let start = 0;
            options.restore !== false && start < writer.head.end;
            start += CHUNK_BYTES
          ) {
            await file.write(
              await source.journal.readRange(writer.head, start, CHUNK_BYTES, capture.signal),
            );
          }
        } finally {
          await file.close();
        }
      }
      capture.signal.throwIfAborted();
      capture.finishIdle = beginIdleTrackedWork();
      captures.set(ref, capture);
      for (const channel of capture.channels) {
        channel.watcher = watch(channel.path, () => {
          capture.dirty = true;
          schedule(capture);
        });
        channel.watcher.on("error", (error) => {
          capture.error = error;
        });
        channel.watcher.unref();
      }
    } catch (error) {
      capture.stopped = true;
      for (const channel of capture.channels) channel.watcher?.close();
      await Promise.allSettled(
        capture.channels.map(async (channel) => {
          await channel.journal.close(channel.writer, capture.signal);
        }),
      );
      if (options.restore !== false)
        await Promise.allSettled(capture.channels.map((channel) => fs.unlink(channel.path)));
      captures.delete(ref);
      capture.finishIdle();
      throw error;
    }
  }
  async function finish(ref: string) {
    const capture = captures.get(ref);
    if (!capture) return;
    capture.stopped = true;
    for (const channel of capture.channels) channel.watcher?.close();
    try {
      await capture.flush;
      if (capture.error) throw capture.error;
      await sync(capture);
      for (const channel of capture.channels)
        channel.writer = await channel.journal.close(channel.writer, capture.signal);
    } finally {
      if (capture.timer) clearTimeout(capture.timer);
      captures.delete(ref);
      capture.finishIdle();
    }
  }
  async function* readChunks(ref: string, signal?: AbortSignal) {
    let nativeTail: number | undefined;
    for (const [index, { journal }] of channelsFor(ref).entries()) {
      const snapshot = await journal.head(signal);
      if (!snapshot || snapshot.head.deleted) throw new Error("provider_trace_payload_unavailable");
      if (snapshot.head.end > MAX_CAPTURE_BYTES)
        throw new Error("provider_trace_capture_size_invalid");
      if (index === 1 && snapshot.head.end && nativeTail !== undefined && nativeTail !== 10)
        yield Buffer.from("\n");
      for (let offset = 0; offset < snapshot.head.end; offset += CHUNK_BYTES) {
        const bytes = await journal.readRange(snapshot.head, offset, CHUNK_BYTES, signal);
        if (index === 0 && bytes.length) nativeTail = bytes.at(-1);
        yield bytes;
      }
    }
  }
  async function read(ref: string, signal?: AbortSignal) {
    const chunks: Buffer[] = [];
    for await (const bytes of readChunks(ref, signal)) chunks.push(bytes);
    return Buffer.concat(chunks);
  }
  async function stop(ref: string) {
    const capture = captures.get(ref);
    if (!capture) return;
    capture.stopped = true;
    capture.controller.abort(new Error("provider_trace_capture_stopped"));
    if (capture.timer) clearTimeout(capture.timer);
    for (const channel of capture.channels) channel.watcher?.close();
    await capture.flush?.catch(() => undefined);
    captures.delete(ref);
    capture.finishIdle();
  }
  async function stopRun(companyId: string, runId: string) {
    const scope = `s3-segments-v1:${companyId}/${runId}/`;
    await Promise.all([...captures.keys()].filter((ref) => ref.startsWith(scope)).map(stop));
  }
  async function remove(ref: string, signal?: AbortSignal) {
    await stop(ref);
    const results = await Promise.allSettled(
      channelsFor(ref).map(({ journal }) => journal.remove(signal)),
    );
    for (const result of results) if (result.status === "rejected") throw result.reason;
  }
  async function settled(ref: string) {
    for (const { journal } of channelsFor(ref)) {
      const snapshot = await journal.head();
      if (!snapshot || !snapshot.head.closed || snapshot.head.deleted) return false;
    }
    return true;
  }
  return { open, finish, read, readChunks, remove, settled, stopRun };
}
export type ProviderTraceObjectStore = ReturnType<typeof createProviderTraceObjectStore>;
