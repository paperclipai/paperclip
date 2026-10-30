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
  deriveLocalEncryptedInstanceSecret("provider-trace:existing-key", process.env, { allowCreate: false });
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
        deriveLocalEncryptedInstanceSecret(`provider-trace:${root}`, process.env, { allowCreate: false }),
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
        capture.controller.signal.throwIfAborted();
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
            channel.writer = await channel.journal.append(
              channel.writer,
              buffer,
              capture.controller.signal,
            );
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
    options: { restore?: boolean } = {},
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
    options: { restore?: boolean } = {},
  ) {
    if (captures.has(ref)) return;
    const capture: Capture = {
      channels: [],
      controller: new AbortController(),
      stopped: false,
      dirty: false,
      finishIdle: () => undefined,
    };
    try {
      for (const source of channelsFor(ref, filePath)) {
        const current = await source.journal.head();
        const writer = await source.journal.claim({
          expectedOwner: current?.head.owner ?? null,
          assertAuthority,
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
            await file.write(await source.journal.readRange(writer.head, start, CHUNK_BYTES));
          }
        } finally {
          await file.close();
        }
      }
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
          await channel.journal.close(channel.writer);
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
        channel.writer = await channel.journal.close(channel.writer);
    } finally {
      if (capture.timer) clearTimeout(capture.timer);
      captures.delete(ref);
      capture.finishIdle();
    }
  }
  async function read(ref: string) {
    const buffers: Buffer[] = [];
    for (const { journal } of channelsFor(ref)) {
      const snapshot = await journal.head();
      if (!snapshot || snapshot.head.deleted) throw new Error("provider_trace_payload_unavailable");
      if (snapshot.head.end > MAX_CAPTURE_BYTES)
        throw new Error("provider_trace_capture_size_invalid");
      const parts: Buffer[] = [];
      for (let offset = 0; offset < snapshot.head.end; offset += CHUNK_BYTES)
        parts.push(await journal.readRange(snapshot.head, offset, CHUNK_BYTES));
      buffers.push(Buffer.concat(parts));
    }
    const [native, rehydration] = buffers as [Buffer, Buffer];
    return Buffer.concat([
      native,
      ...(native.length && native.at(-1) !== 10 && rehydration.length ? [Buffer.from("\n")] : []),
      rehydration,
    ]);
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
  return { open, finish, read, remove, settled, stopRun };
}
export type ProviderTraceObjectStore = ReturnType<typeof createProviderTraceObjectStore>;
