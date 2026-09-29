import { constants, createReadStream, promises as fs } from "node:fs";
import { createHash, randomUUID, type Hash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { badRequest, notFound, tooManyRequests } from "../errors.js";
import type { StorageProvider } from "../storage/types.js";
import type { RunLogHandle, RunLogReadOptions, RunLogReadResult, RunLogStore, RunLogEvent, RunLogAppendReceipt } from "./run-log-store.js";

const SCHEMA = "paperclip.run-log.segments.v2";
const LEGACY_SCHEMA = "paperclip.run-log.segments.v1";
const MAX_APPEND = 32 * 1024 * 1024;
const MAX_READ = 1024 * 1024;
const EMPTY_HASH = createHash("sha256").digest("hex");

interface Head {
  schema: typeof SCHEMA | typeof LEGACY_SCHEMA;
  logRef: string;
  segmentBytes: number;
  bytes: string;
  revision: string;
  tailSha256: string;
  finalized: boolean;
  writerId?: string;
  tailObject?: string;
  retiredTail?: string;
  lastRecordCursor?: string;
}
interface Writer {
  head: Head;
  tailHash: Hash;
  chain: Promise<unknown>;
  queued: number;
  failed: boolean;
  timer?: NodeJS.Timeout;
  dirty: boolean;
  remoteEtag: string | null;
}
export interface SegmentedRunLogOptions {
  basePath: string;
  /** Smaller sizes are useful for deterministic rotation/fault tests. */
  segmentBytes?: number;
  s3?: { provider: StorageProvider; keyPrefix?: string; inflightMirrorMs?: number };
  onBoundary?: (boundary: "segment" | "head" | "remote-tail" | "remote-head") => Promise<void>;
}

function integer(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw badRequest("Invalid run log cursor");
  return BigInt(value);
}
function safeRef(value: string): string {
  if (!/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.segments$/.test(value)) throw badRequest("Invalid run log reference");
  return value;
}
function segmentPath(index: bigint): string {
  // Direct arithmetic routing: no growing manifest or directory enumeration.
  const value = index.toString(16).padStart(4, "0");
  return `segments/${value.slice(0, -2)}/${value.slice(-2)}.ndjson`;
}
function parseHead(bytes: Buffer, logRef: string): Head {
  if (bytes.length > 4096) throw new Error("run_log_head_invalid");
  const head = JSON.parse(bytes.toString()) as Head;
  if ((head.schema !== SCHEMA && head.schema !== LEGACY_SCHEMA) || head.logRef !== logRef || typeof head.bytes !== "string" || typeof head.revision !== "string" ||
      !Number.isSafeInteger(head.segmentBytes) || head.segmentBytes < 64 || head.segmentBytes > MAX_APPEND ||
      !/^[0-9a-f]{64}$/.test(head.tailSha256) || typeof head.finalized !== "boolean") throw new Error("run_log_head_invalid");
  if ((head.writerId !== undefined && !/^[0-9a-f-]{36}$/.test(head.writerId)) ||
      (head.tailObject !== undefined && !/^tails\/[0-9a-f-]{36}\/(0|[1-9][0-9]*)\.ndjson$/.test(head.tailObject))) throw new Error("run_log_head_invalid");
  if (head.retiredTail !== undefined && (!/^tails\/(?:[0-9a-f-]{36}\/)?(0|[1-9][0-9]*)\.ndjson$/.test(head.retiredTail) || head.retiredTail === head.tailObject)) throw new Error("run_log_head_invalid");
  integer(head.bytes); integer(head.revision);
  if (head.lastRecordCursor !== undefined && (typeof head.lastRecordCursor !== "string" ||
      integer(head.lastRecordCursor) >= integer(head.bytes) || integer(head.bytes) - integer(head.lastRecordCursor) > BigInt(MAX_APPEND))) {
    throw new Error("run_log_head_invalid");
  }
  return head;
}
async function syncDirectory(path: string) {
  if (process.platform === "win32") return;
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function privateRead(path: string, maximum: number): Promise<Buffer> {
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > maximum || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("run_log_file_unsafe");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const read = await fd.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error("run_log_file_changed"); offset += read.bytesRead; }
    const after = await fd.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("run_log_file_changed");
    return bytes;
  } finally { await fd.close(); }
}
async function durableWrite(path: string, bytes: Buffer, createOnly = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = await fs.open(temp, "wx", 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); }
  finally { await fd.close(); }
  try {
    if (createOnly) await fs.link(temp, path).catch(error => { if (error.code !== "EEXIST") throw error; });
    else await fs.rename(temp, path);
    await syncDirectory(dirname(path));
  }
  finally { await fs.rm(temp, { force: true }); }
}
async function collect(stream: Readable, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let length = 0;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    length += chunk.length;
    if (length > maximum) { stream.destroy(); throw new Error("run_log_read_oversize"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Fixed-size segments with a bounded current tail. The caller's run lease
 * owns the sole writer. A failed/indeterminate write fences that writer until
 * it is reopened under a freshly verified lease. Completed segments are never
 * read or rewritten by append, reopen, mirror, or finalize. */
export function createSegmentedRunLogStore(options: SegmentedRunLogOptions): RunLogStore {
  const base = resolve(options.basePath);
  const segmentBytes = options.segmentBytes ?? MAX_APPEND;
  if (!Number.isSafeInteger(segmentBytes) || segmentBytes < 64 || segmentBytes > MAX_APPEND) throw new Error("run_log_segment_size_invalid");
  const writers = new Map<string, Writer>();
  const opening = new Map<string, Promise<Writer>>();
  // Verification is per fixed-size segment, never per complete log. Cache at
  // most two verified segments and run at most two distinct reads at once.
  // A task page opens several prior run logs concurrently. Queue their small
  // descriptors instead of treating its third read as an internal error.
  const verified = new Map<string, Buffer>();
  const verifying = new Map<string, Promise<Buffer>>();
  let activeReads = 0;
  const waitingReads: Array<() => void> = [];
  async function acquireRead(): Promise<() => void> {
    if (activeReads < 2) activeReads++;
    else {
      if (waitingReads.length >= 64) throw tooManyRequests("Run log reads are busy. Try again shortly.");
      await new Promise<void>((resolve, reject) => {
        const ready = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = waitingReads.indexOf(ready);
          if (index !== -1) waitingReads.splice(index, 1);
          reject(tooManyRequests("Run log reads are busy. Try again shortly."));
        }, 30_000);
        timer.unref();
        waitingReads.push(ready);
      });
    }
    return () => {
      const next = waitingReads.shift();
      if (next) next(); // Transfer this credit; a newcomer cannot steal it.
      else activeReads--;
    };
  }
  const prefix = options.s3?.keyPrefix?.replace(/^\/+|\/+$/g, "");
  const key = (ref: string, relative: string) => [prefix, safeRef(ref), relative].filter(Boolean).join("/");
  const local = (ref: string, relative: string) => join(base, safeRef(ref), relative);

  async function ensureDirectory(path: string) {
    await fs.mkdir(base, { recursive: true, mode: 0o700 });
    const baseStat = await fs.lstat(base);
    if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new Error("run_log_directory_unsafe");
    const relative = path.slice(base.length + 1);
    if (!path.startsWith(base + sep) || relative.split(sep).some(part => part === "..")) throw new Error("run_log_directory_unsafe");
    let current = base;
    let depth = 0;
    for (const part of relative.split(sep)) {
      depth++;
      current = join(current, part);
      let created = true;
      await fs.mkdir(current, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; created = false; });
      const stat = await fs.lstat(current);
      // Company/agent directories may predate this format. Only the private
      // run directory and its children require 0700; every ancestor must still
      // be a real directory owned by this service.
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((depth >= 3 && (stat.mode & 0o077) !== 0) || stat.uid !== process.getuid?.()))) throw new Error("run_log_directory_unsafe");
      if (created) await syncDirectory(dirname(current));
    }
  }
  async function assertDirectory(path: string) {
    if (!path.startsWith(base + sep)) throw new Error("run_log_directory_unsafe");
    let current = base;
    const root = await fs.lstat(current);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error("run_log_directory_unsafe");
    let depth = 0;
    for (const part of path.slice(base.length + 1).split(sep)) {
      depth++;
      current = join(current, part);
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && ((depth >= 3 && (stat.mode & 0o077) !== 0) || stat.uid !== process.getuid?.()))) throw new Error("run_log_directory_unsafe");
    }
  }
  async function put(ref: string, relative: string, body: Buffer | ReturnType<typeof createReadStream>, length: number, sha256: string) {
    if (!options.s3) return;
    try {
      await options.s3.provider.putObjectConditional!({ objectKey: key(ref, relative), body, contentLength: length, contentType: relative.endsWith(".json") ? "application/json" : "application/x-ndjson", sha256 }, null);
    } catch (error) {
      if (!Buffer.isBuffer(body)) body.destroy();
      const code = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (code.name !== "PreconditionFailed" && code.$metadata?.httpStatusCode !== 412) throw error;
      // A replay may reuse identical immutable bytes. A competing writer's
      // different segment can never be overwritten, even before its head CAS.
      const prior = await options.s3.provider.getObject({ objectKey: key(ref, relative) });
      const bytes = await collect(prior.stream, length);
      if (bytes.length !== length || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("run_log_immutable_object_conflict");
    }
  }
  const remoteTail = (head: Head) => head.tailObject ?? `tails/${head.revision}.ndjson`;
  async function remoteHead(ref: string): Promise<{ head: Head; etag: string } | null> {
    const provider = options.s3!.provider, objectKey = key(ref, "head.json");
    if (!(await provider.headObject({ objectKey })).exists) return null;
    const result = await provider.getObject({ objectKey });
    if (!result.etag) { result.stream.destroy(); throw new Error("run_log_remote_head_etag_missing"); }
    return { head: parseHead(await collect(result.stream, 4096), ref), etag: result.etag };
  }
  async function readHead(ref: string): Promise<{ head: Head; remote: boolean }> {
    try {
      await assertDirectory(local(ref, ""));
      return { head: parseHead(await privateRead(local(ref, "head.json"), 4096), ref), remote: false };
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!options.s3) throw notFound("Run log not found");
    const result = await options.s3.provider.getObject({ objectKey: key(ref, "head.json") });
    return { head: parseHead(await collect(result.stream, 4096), ref), remote: true };
  }
  async function segmentReference(ref: string, relative: string, index: bigint, bytes: number) {
    let encoded: Buffer;
    try {
      await assertDirectory(dirname(local(ref, relative)));
      encoded = await privateRead(local(ref, `${relative}.json`), 4096);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.s3) throw error;
      encoded = await collect((await options.s3.provider.getObject({ objectKey: key(ref, `${relative}.json`) })).stream, 4096);
    }
    const value = JSON.parse(encoded.toString()) as Record<string, unknown>;
    if (!["paperclip.run-log.segment.v1", "paperclip.run-log.segment.v2"].includes(String(value.schema)) || value.logRef !== ref || value.segment !== String(index) || value.bytes !== bytes ||
        typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error("run_log_segment_reference_invalid");
    if (value.object !== undefined && (value.object !== `${relative}.${value.sha256}` || typeof value.writerId !== "string" || !/^[0-9a-f-]{36}$/.test(value.writerId))) throw new Error("run_log_segment_reference_invalid");
    if (value.schema === "paperclip.run-log.segment.v2" && value.object === undefined) throw new Error("run_log_segment_reference_invalid");
    return { sha256: value.sha256, object: typeof value.object === "string" ? value.object : relative };
  }
  async function verifiedSegment(head: Head, index: bigint, remote: boolean, refreshTail = true, admitted = false): Promise<Buffer> {
    const ref = head.logRef, relative = segmentPath(index);
    const tail = index === integer(head.bytes) / BigInt(head.segmentBytes);
    const length = tail ? Number(integer(head.bytes) % BigInt(head.segmentBytes)) : head.segmentBytes;
    const reference = tail ? { sha256: head.tailSha256, object: remoteTail(head) } : await segmentReference(ref, relative, index, length);
    const sha256 = reference.sha256;
    const identity = `${ref}:${index}:${length}:${sha256}`;
    const cached = verified.get(identity);
    if (cached) { verified.delete(identity); verified.set(identity, cached); return cached; }
    // A retired-tail retry already owns a read credit. It must not join a
    // queued request for the newer head which is waiting for that same credit.
    const existing = admitted ? undefined : verifying.get(identity);
    if (existing) return existing;
    const pending = (async () => {
      const release = admitted ? () => {} : await acquireRead();
      try {
        // Another credited read may have populated this while we were queued.
        const cached = verified.get(identity);
        if (cached) return cached;
        let bytes: Buffer | undefined;
        if (!remote) {
          let fd;
          try {
            await assertDirectory(dirname(local(ref, relative)));
            fd = await fs.open(local(ref, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const stat = await fd.stat();
            if (!stat.isFile() || stat.size < length || stat.size > head.segmentBytes || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("run_log_segment_unsafe");
            bytes = Buffer.alloc(length);
            let offset = 0;
            while (offset < length) { const result = await fd.read(bytes, offset, length - offset, offset); if (!result.bytesRead) throw new Error("run_log_segment_missing"); offset += result.bytesRead; }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !options.s3 || tail) throw error;
          } finally { await fd?.close(); }
        }
        if (!bytes) {
          try {
            const result = await options.s3!.provider.getObject({ objectKey: key(ref, reference.object) });
            bytes = await collect(result.stream, length);
          } catch (error) {
            if (!tail || !refreshTail || (error as { status?: number }).status !== 404) throw error;
            const newer = await remoteHead(ref);
            if (!newer || newer.head.segmentBytes !== head.segmentBytes || integer(newer.head.bytes) < integer(head.bytes) || remoteTail(newer.head) === reference.object) throw error;
            // Mirroring can retire a tail after this reader read its old head.
            // Fetch at most one newer segment and verify its exact old prefix
            // against the original head before returning this snapshot's page.
            if (newer.head.bytes === head.bytes && newer.head.tailSha256 === head.tailSha256) {
              // An ownership claim can change only the object's location. Its
              // cache identity is identical: joining our own in-flight promise
              // would deadlock. Read that new object directly instead.
              bytes = await collect((await options.s3!.provider.getObject({ objectKey: key(ref, remoteTail(newer.head)) })).stream, length);
            } else {
              const current = await verifiedSegment(newer.head, index, true, false, true);
              bytes = Buffer.from(current.subarray(0, length));
            }
          }
        }
        if (bytes.length !== length || createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error("run_log_segment_digest_mismatch");
        verified.set(identity, bytes);
        while (verified.size > 2) verified.delete(verified.keys().next().value!);
        return bytes;
      } finally { release(); }
    })().finally(() => { if (!admitted) verifying.delete(identity); });
    if (!admitted) verifying.set(identity, pending);
    return pending;
  }
  async function restoreWriter(ref: string): Promise<Writer> {
    if (options.s3 && !options.s3.provider.putObjectConditional) throw new Error("run_log_conditional_storage_required");
    const existing = writers.get(ref);
    if (existing) return existing;
    const { head, remote } = await readHead(ref);
    const published = options.s3 ? await remoteHead(ref) : null;
    if (published) {
      const prior = published.head;
      const sameBytes = prior.bytes === head.bytes && prior.revision === head.revision && prior.tailSha256 === head.tailSha256;
      if (prior.segmentBytes !== head.segmentBytes || (prior.finalized && !head.finalized) ||
          integer(prior.bytes) > integer(head.bytes) || integer(prior.revision) > integer(head.revision) ||
          (!sameBytes && prior.writerId !== head.writerId)) throw new Error("run_log_remote_owner_changed");
    }
    const tailHash = createHash("sha256");
    const tailBytes = Number(integer(head.bytes) % BigInt(head.segmentBytes));
    if (remote) {
      if (tailBytes) {
        const bytes = await verifiedSegment(head, integer(head.bytes) / BigInt(head.segmentBytes), true);
        const path = local(ref, segmentPath(integer(head.bytes) / BigInt(head.segmentBytes)));
        await ensureDirectory(dirname(path));
        await durableWrite(path, bytes);
      }
      await ensureDirectory(local(ref, "segments"));
      await durableWrite(local(ref, "head.json"), Buffer.from(JSON.stringify(head)));
    }
    if (tailBytes) {
      // Only the current tail is needed after a controller restart. A partial
      // uncommitted append is discarded using the durable head's exact length.
      const path = local(ref, segmentPath(integer(head.bytes) / BigInt(head.segmentBytes)));
      await assertDirectory(dirname(path));
      const fd = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size < tailBytes || stat.size > head.segmentBytes ||
            (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("run_log_tail_invalid");
        const bytes = Buffer.alloc(tailBytes);
        let offset = 0;
        while (offset < bytes.length) { const read = await fd.read(bytes, offset, bytes.length - offset, offset); if (!read.bytesRead) throw new Error("run_log_tail_missing"); offset += read.bytesRead; }
        tailHash.update(bytes);
        if (tailHash.copy().digest("hex") !== head.tailSha256) throw new Error("run_log_tail_digest_mismatch");
        if (stat.size !== tailBytes) { await fd.truncate(tailBytes); await fd.sync(); }
      } finally { await fd.close(); }
    } else if (head.tailSha256 !== EMPTY_HASH) throw new Error("run_log_tail_digest_mismatch");
    const writer: Writer = { head: { ...head, schema: SCHEMA, ...(options.s3 ? { writerId: randomUUID() } : {}) }, tailHash, chain: Promise.resolve(), queued: 0, failed: false, dirty: !head.finalized, remoteEtag: published?.etag ?? null };
    if (options.s3 && !head.finalized) {
      // Claim this writer at the remote authority before begin returns. A late
      // upload by an older owner holds a different ETag and cannot roll it back.
      await mirror(writer);
    }
    writers.set(ref, writer);
    return writer;
  }
  async function openWriter(ref: string): Promise<Writer> {
    const existing = writers.get(ref);
    if (existing) return existing;
    let pending = opening.get(ref);
    if (!pending) {
      pending = restoreWriter(ref).finally(() => { opening.delete(ref); });
      opening.set(ref, pending);
    }
    return pending;
  }
  async function serialize<T>(ref: string, action: (writer: Writer) => Promise<T>): Promise<T> {
    const writer = await openWriter(ref);
    if (writer.failed) throw new Error("run_log_writer_fenced");
    if (writer.queued >= 8) throw new Error("run_log_storage_pressure");
    writer.queued++;
    const pending = writer.chain.then(async () => {
      if (writer.failed) throw new Error("run_log_writer_fenced");
      try { return await action(writer); }
      catch (error) { writer.failed = true; throw error; }
      finally { writer.queued--; }
    });
    writer.chain = pending.catch(() => undefined);
    return pending;
  }
  async function mirror(writer: Writer) {
    if (!options.s3 || !writer.dirty) return;
    const head = { ...writer.head };
    if (head.retiredTail) {
      await options.s3.provider.deleteObject({ objectKey: key(head.logRef, head.retiredTail) });
      delete head.retiredTail;
    }
    const tailBytes = Number(integer(head.bytes) % BigInt(head.segmentBytes));
    const previousTail = writer.head.tailObject;
    if (tailBytes) {
      const path = local(head.logRef, segmentPath(integer(head.bytes) / BigInt(head.segmentBytes)));
      // Each mirrored tail has its own identity; a late old upload cannot
      // change bytes referenced by a newer published head.
      head.tailObject = `tails/${head.writerId}/${head.revision}.ndjson`;
      await put(head.logRef, head.tailObject, createReadStream(path, { start: 0, end: tailBytes - 1 }), tailBytes, head.tailSha256);
      await options.onBoundary?.("remote-tail");
    } else delete head.tailObject;
    if (previousTail && previousTail !== head.tailObject) head.retiredTail = previousTail;
    const bytes = Buffer.from(JSON.stringify(head));
    const published = await options.s3.provider.putObjectConditional!({ objectKey: key(head.logRef, "head.json"), body: bytes,
      contentLength: bytes.length, contentType: "application/json", sha256: createHash("sha256").update(bytes).digest("hex") }, writer.remoteEtag);
    writer.remoteEtag = published.etag;
    await options.onBoundary?.("remote-head");
    await durableWrite(local(head.logRef, "head.json"), bytes);
    writer.head = head;
    // One durable pending deletion, never a lifetime-sized tail catalog.
    // Missing-object readers retry against a newer head and verify the old
    // prefix. Unknown prepublication failures still need orphan maintenance.
    if (head.retiredTail) await options.s3.provider.deleteObject({ objectKey: key(head.logRef, head.retiredTail) });
    writer.dirty = false;
  }
  async function publishSegment(writer: Writer, index: bigint, relative: string, path: string, hash: string, reference: Buffer) {
    if (!options.s3) return;
    const provider = options.s3.provider, ref = writer.head.logRef;
    // Content-addressed bodies are immutable. An interrupted append may have
    // published a different, unreferenced body for this ordinal; it cannot
    // corrupt the next owner's committed segment by overwriting that object.
    await put(ref, `${relative}.${hash}`, createReadStream(path), writer.head.segmentBytes, hash);
    const objectKey = key(ref, `${relative}.json`);
    const previous = await provider.headObject({ objectKey });
    if (previous.exists && !previous.etag) throw new Error("run_log_remote_segment_etag_missing");
    // Capture the reference ETag BEFORE checking ownership. A later owner
    // publishes its own UUID in the reference, preventing an ETag ABA even
    // when it uses identical content. The old writer cannot replace it.
    const current = await remoteHead(ref);
    if (!current || current.etag !== writer.remoteEtag || current.head.writerId !== writer.head.writerId) throw new Error("run_log_remote_owner_changed");
    if (index < integer(current.head.bytes) / BigInt(current.head.segmentBytes)) throw new Error("run_log_segment_already_published");
    await provider.putObjectConditional!({ objectKey, body: reference, contentLength: reference.length,
      contentType: "application/json", sha256: createHash("sha256").update(reference).digest("hex") }, previous.etag ?? null);
  }
  function schedule(writer: Writer) {
    if (!options.s3 || !options.s3.inflightMirrorMs || writer.timer || writer.head.finalized) return;
    writer.timer = setTimeout(() => {
      writer.timer = undefined;
      void serialize(writer.head.logRef, mirror).catch(() => { /* The fenced writer reports the resource failure on its next operation. */ });
    }, options.s3.inflightMirrorMs);
    writer.timer.unref();
  }
  async function appendRecord(handle: RunLogHandle, event: RunLogEvent, positioned: boolean): Promise<RunLogAppendReceipt> {
      // One append is bounded live work; its size never depends on history.
      if (Buffer.byteLength(event.chunk) > MAX_APPEND / 2) throw new Error("run_log_append_too_large");
      return serialize(handle.logRef, async writer => {
        if (writer.head.finalized) throw new Error("run_log_finalized");
        let total = integer(writer.head.bytes);
        const cursor = String(total);
        const bytes = Buffer.from(`${JSON.stringify(positioned ? { ...event, cursor } : event)}\n`);
        if (bytes.length > MAX_APPEND) throw new Error("run_log_append_too_large");
        const size = BigInt(writer.head.segmentBytes);
        let consumed = 0;
        while (consumed < bytes.length) {
          const index = total / size;
          const offset = Number(total % size);
          const count = Math.min(bytes.length - consumed, Number(size) - offset);
          const relative = segmentPath(index);
          const path = local(handle.logRef, relative);
          await ensureDirectory(dirname(path));
          const fd = await fs.open(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
          try {
            const stat = await fd.stat();
            if (!stat.isFile() || stat.size < offset || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error("run_log_segment_unsafe");
            await fd.truncate(offset);
            let written = 0;
            while (written < count) { const result = await fd.write(bytes, consumed + written, count - written, offset + written); if (!result.bytesWritten) throw new Error("run_log_short_write"); written += result.bytesWritten; }
            await fd.sync();
          } finally { await fd.close(); }
          writer.tailHash.update(bytes.subarray(consumed, consumed + count));
          consumed += count; total += BigInt(count);
          if (total % size === 0n) {
            const hash = writer.tailHash.digest("hex");
            const reference = Buffer.from(JSON.stringify({ schema: options.s3 ? "paperclip.run-log.segment.v2" : "paperclip.run-log.segment.v1", logRef: handle.logRef, segment: String(index), bytes: Number(size), sha256: hash,
              ...(options.s3 ? { object: `${relative}.${hash}`, writerId: writer.head.writerId } : {}) }));
            await durableWrite(`${path}.json`, reference);
            // Completed segments reach configured object storage before the
            // local head can acknowledge them. Failed uploads hold admission.
            await publishSegment(writer, index, relative, path, hash, reference);
            writer.tailHash = createHash("sha256");
            await options.onBoundary?.("segment");
          }
        }
        const head = { ...writer.head, bytes: String(total), lastRecordCursor: cursor,
          revision: String(integer(writer.head.revision) + 1n), tailSha256: writer.tailHash.copy().digest("hex") };
        if (options.s3) {
          const current = await remoteHead(handle.logRef);
          if (!current || current.etag !== writer.remoteEtag || current.head.writerId !== writer.head.writerId) throw new Error("run_log_remote_owner_changed");
        }
        await durableWrite(local(handle.logRef, "head.json"), Buffer.from(JSON.stringify(head)));
        await options.onBoundary?.("head");
        writer.head = head; writer.dirty = true;
        schedule(writer);
        return { bytes: bytes.length, cursor, nextCursor: String(total) };
      });
  }
  return {
    async begin(input) {
      if (options.s3 && !options.s3.provider.putObjectConditional) throw new Error("run_log_conditional_storage_required");
      const ref = safeRef(`${input.companyId}/${input.agentId}/${input.runId}.segments`);
      const failed = writers.get(ref);
      if (failed?.failed) {
        // begin is admitted by the caller's fresh run lease. Join all work
        // owned by the failed writer before reconstructing its durable head.
        if (failed.timer) clearTimeout(failed.timer);
        await failed.chain;
        if (writers.get(ref) === failed) writers.delete(ref);
      }
      await ensureDirectory(local(ref, "segments"));
      try { await privateRead(local(ref, "head.json"), 4096); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!options.s3 || !(await options.s3.provider.headObject({ objectKey: key(ref, "head.json") })).exists) {
          const head: Head = { schema: SCHEMA, logRef: ref, segmentBytes, bytes: "0", revision: "0", tailSha256: EMPTY_HASH, finalized: false };
          await durableWrite(local(ref, "head.json"), Buffer.from(JSON.stringify(head)), true);
        }
      }
      schedule(await openWriter(ref));
      return { store: "local_segments", logRef: ref };
    },
    async append(handle, event) { return (await appendRecord(handle, event, false)).bytes; },
    appendPositioned: (handle, event) => appendRecord(handle, event, true),
    async finalize(handle) {
      return serialize(handle.logRef, async writer => {
        if (writer.timer) { clearTimeout(writer.timer); writer.timer = undefined; }
        writer.head = { ...writer.head, finalized: true };
        await durableWrite(local(handle.logRef, "head.json"), Buffer.from(JSON.stringify(writer.head)));
        writer.dirty = true;
        await mirror(writer);
        const total = integer(writer.head.bytes);
        writers.delete(handle.logRef);
        // A whole-history SHA would require a history-sized finalization scan.
        // Segment hashes are the integrity contract for this format.
        return { bytes: total <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(total) : null, bytesExact: String(total), compressed: false };
      });
    },
    async read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult> {
      const { head, remote } = await readHead(handle.logRef);
      const total = integer(head.bytes);
      const limit = opts?.limitBytes ?? 256_000;
      if (!Number.isSafeInteger(limit) || limit < 4 || limit > MAX_READ) throw badRequest("Invalid run log page size");
      let start = opts?.cursor === "tail" ? (total > BigInt(limit) ? total - BigInt(limit) : 0n)
        : opts?.cursor !== undefined ? integer(opts.cursor) : BigInt(opts?.offset ?? 0);
      if (start < 0n || start > total || (!opts?.cursor && !Number.isSafeInteger(opts?.offset ?? 0))) throw badRequest("Invalid run log cursor");
      if (opts?.cursor === "tail" && start > 0n) {
        let lastRecord = head.lastRecordCursor === undefined ? undefined : integer(head.lastRecordCursor);
        if (lastRecord === undefined) {
          // Retained heads predate this index. Search at most one admitted
          // record, backwards through verified segments, without collecting
          // the record or scanning lifetime history. Exclude its final LF.
          const floor = total > BigInt(MAX_APPEND + 1) ? total - BigInt(MAX_APPEND + 1) : 0n;
          let end = total - 1n;
          while (end > floor) {
            const size = BigInt(head.segmentBytes), index = (end - 1n) / size;
            const base = index * size, from = floor > base ? floor : base;
            const bytes = await verifiedSegment(head, index, remote);
            const newline = bytes.subarray(Number(from - base), Number(end - base)).lastIndexOf(10);
            if (newline >= 0) { lastRecord = from + BigInt(newline) + 1n; break; }
            end = from;
          }
          if (lastRecord === undefined) {
            if (floor !== 0n) throw new Error("run_log_tail_record_invalid");
            lastRecord = 0n;
          }
        }
        // A large final row needs several ordinary pages. Starting inside it
        // would discard the only row and incorrectly report EOF to the UI.
        if (lastRecord < start) start = lastRecord;
      }
      const wanted = Number(total - start > BigInt(limit) ? BigInt(limit) : total - start);
      const chunks: Buffer[] = [];
      let position = start;
      while (position < start + BigInt(wanted)) {
        const index = position / BigInt(head.segmentBytes);
        const offset = Number(position % BigInt(head.segmentBytes));
        const length = Math.min(head.segmentBytes - offset, wanted - Number(position - start));
        const bytes = await verifiedSegment(head, index, remote);
        // Copy only the requested page; a slice must not pin evicted 32 MiB
        // backing buffers while a page crosses many small historical segments.
        chunks.push(Buffer.from(bytes.subarray(offset, offset + length)));
        position += BigInt(length);
      }
      const bytes = Buffer.concat(chunks);
      // Leave a trailing partial UTF-8 character for the next page. Byte
      // cursors refer to persisted bytes, independent of rendered text length.
      let used = bytes.length;
      if (position < total && used) {
        let lead = used - 1;
        while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead--;
        const first = bytes[lead]!;
        const width = first < 0x80 ? 1 : first < 0xe0 ? 2 : first < 0xf0 ? 3 : 4;
        if (used - lead < width) used = lead;
      }
      const cursor = start + BigInt(used);
      return { content: bytes.subarray(0, used).toString("utf8"), cursor: String(cursor), hasMore: cursor < total,
        ...(cursor < total && cursor <= BigInt(Number.MAX_SAFE_INTEGER) ? { nextOffset: Number(cursor) } : {}) };
    },
    async flushInflightMirrors() {
      for (const [ref, writer] of writers) {
        if (writer.timer) { clearTimeout(writer.timer); writer.timer = undefined; }
        await serialize(ref, mirror);
      }
    },
  };
}
