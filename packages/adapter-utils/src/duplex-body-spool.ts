/**
 * Receive-side body reassembly and spill for the sandbox duplex channel.
 *
 * The duplex codec splits one request body or one response body into an envelope
 * frame plus a sequence of `body_chunk` frames. This module reassembles those
 * chunks back into one body. The receiver reads `bodyByteCount` from the envelope
 * first, then chooses one of two paths before it reads the first chunk:
 *   - memory path: a body at or below the spill threshold stays in a memory
 *     buffer.
 *   - spill path: a body above the spill threshold streams to a temporary file,
 *     so the receiver never holds a whole large body in memory.
 *
 * The spill path bounds the disk a single channel can consume. A per-channel
 * arena caps the bytes on disk and the number of open spill files. The receiver
 * reserves a file slot and reserves bytes before it opens a file and before each
 * write. A reserve that exceeds a cap fails closed: it rejects the body as a
 * resource error and unlinks any partial file.
 *
 * The reassembler treats every frame as untrusted. It rejects a bad chunk as a
 * loud, terminal protocol error: a non-canonical base64 payload, a wrong chunk
 * size, an out-of-order `seq`, a total that does not equal `bodyByteCount`, or a
 * chunk that arrives for a completed or unknown body.
 */

import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  DUPLEX_BODY_CHUNK_RAW_BYTES,
  type DuplexBodyChunkFrame,
} from "./duplex-frame-codec.js";

/**
 * The default spill threshold, in bytes. A body at or below this size stays in
 * memory. A body above it spills to disk. The value is 1 MiB. It stays
 * injectable so a test can lower it and exercise the spill path.
 */
export const DEFAULT_DUPLEX_BODY_SPILL_THRESHOLD_BYTES = 1024 * 1024;

/**
 * The default per-channel spill byte cap. The receiver keeps at most this many
 * bytes on disk at one time for one channel. The value is 64 MiB. It is about
 * 0.64% of the default 10 GiB sandbox disk and stays far below the security
 * ceiling of 25% of the disk quota. It stays injectable so a test can lower it.
 */
export const DEFAULT_DUPLEX_CHANNEL_SPILL_BYTE_CAP = 64 * 1024 * 1024;

/**
 * The default per-channel open-file cap. The receiver keeps at most this many
 * spill files open at one time for one channel. The value derives from the byte
 * cap and the spill threshold: 64 MiB divided by the 1 MiB spill floor gives 64.
 * It stays injectable so a test can lower it.
 */
export const DEFAULT_DUPLEX_CHANNEL_SPILL_FILE_CAP = 64;

/** The prefix of every spill directory name. The startup sweep matches it. */
const SPILL_DIR_PREFIX = "paperclip-duplex-spill-";

/** The config a caller passes to build a {@link DuplexBodyReceiver}. */
export interface DuplexBodyReceiverConfig {
  /** The spill threshold in bytes. Defaults to {@link DEFAULT_DUPLEX_BODY_SPILL_THRESHOLD_BYTES}. */
  spillThresholdBytes?: number;
  /** The fixed raw chunk size in bytes. Defaults to {@link DUPLEX_BODY_CHUNK_RAW_BYTES}. */
  rawChunkBytes?: number;
  /** The per-channel spill byte cap. Defaults to {@link DEFAULT_DUPLEX_CHANNEL_SPILL_BYTE_CAP}. */
  channelSpillByteCap?: number;
  /** The per-channel open-file cap. Defaults to {@link DEFAULT_DUPLEX_CHANNEL_SPILL_FILE_CAP}. */
  channelSpillFileCap?: number;
  /** The root directory that holds the spill directory. Defaults to the OS temp dir. */
  spillRootDir?: string;
  /** A diagnostic sink for a non-fatal cleanup note. The receiver names no body id here. */
  logger?: (message: string) => void;
}

/** The reason the reassembler rejected a body. Each reason is a terminal protocol error. */
export type DuplexBodyErrorCode =
  | "chunk_without_envelope"
  | "chunk_after_completion"
  | "seq_out_of_order"
  | "chunk_not_canonical_base64"
  | "chunk_wrong_size"
  | "empty_chunk"
  | "body_overrun"
  | "zero_body_has_chunk"
  | "spill_cap_exceeded"
  | "spill_write_failed"
  | "path_escape"
  | "channel_closed";

/** A reassembly error. The receiver returns it; it never leaks a raw path or a raw provider string. */
export class DuplexBodyError extends Error {
  readonly code: DuplexBodyErrorCode;
  constructor(code: DuplexBodyErrorCode, message: string) {
    super(message);
    this.name = "DuplexBodyError";
    this.code = code;
  }
}

/**
 * One reassembled body. The memory path holds the whole body in a buffer. The
 * spill path holds a temporary file. A caller reads the memory buffer, or opens
 * a fresh read stream, then disposes the body once.
 */
export interface ReassembledBody {
  /** The raw byte length of the body. */
  readonly byteCount: number;
  /** True when the body spilled to disk. */
  readonly spilled: boolean;
  /**
   * The whole body as a buffer. The memory path returns it. The spill path
   * throws, because the spill path must never load a whole large body into
   * memory on the receive side. A caller streams a spilled body instead.
   */
  readMemory(): Buffer;
  /** A fresh read stream over the body. The memory path streams one buffer; the spill path streams the file. */
  createReadStream(): Readable;
  /** Release the body. The spill path unlinks the file and releases the reservation exactly once. */
  dispose(): Promise<void>;
}

/**
 * The per-channel arena that bounds the spill disk use. It tracks the bytes on
 * disk and the open files, and it owns the spill directory. It hands out
 * reservations and takes them back. The reservation math is synchronous, so a
 * concurrent reserve never races past a cap.
 */
class SpillArena {
  usedBytes = 0;
  openFiles = 0;
  constructor(
    readonly dir: string,
    private readonly byteCap: number,
    private readonly fileCap: number,
  ) {}

  /** Reserve one open-file slot. Return false when the file cap is already at the limit. */
  reserveFile(): boolean {
    if (this.openFiles >= this.fileCap) return false;
    this.openFiles += 1;
    return true;
  }

  /** Release one open-file slot. */
  releaseFile(): void {
    if (this.openFiles > 0) this.openFiles -= 1;
  }

  /** Reserve `n` bytes of disk. Return false when the byte cap would be exceeded. */
  reserveBytes(n: number): boolean {
    if (this.usedBytes + n > this.byteCap) return false;
    this.usedBytes += n;
    return true;
  }

  /** Release `n` bytes of disk. */
  releaseBytes(n: number): void {
    this.usedBytes -= n;
    if (this.usedBytes < 0) this.usedBytes = 0;
  }
}

/** The internal state of one in-flight body. */
interface ActiveBody {
  bodyByteCount: number;
  nextSeq: number;
  receivedBytes: number;
  spilled: boolean;
  /** Memory-path accumulation. Empty for the spill path. */
  memoryChunks: Buffer[];
  /** The spill file path. Null for the memory path. */
  filePath: string | null;
  /** The open spill file handle. Null for the memory path or before the first write. */
  handle: FileHandle | null;
  /** The bytes this body reserved in the arena. The dispose path releases exactly this many. */
  reservedBytes: number;
  /** True when the body holds an arena file slot that the dispose path must release. */
  holdsFileSlot: boolean;
  /** True once the dispose path ran, so it runs its release once. */
  disposed: boolean;
  /** Resolve the completion promise the caller awaits. */
  resolve: (body: ReassembledBody) => void;
  /** Reject the completion promise on a terminal error. */
  reject: (error: DuplexBodyError) => void;
  /** Serialize the spill writes, so the chunks land on disk in `seq` order. */
  writeChain: Promise<void>;
  /** True once the body settled (resolved or rejected), so a late chunk never double-settles. */
  settled: boolean;
}

/** The synchronous result of one `pushChunk` call. */
export type DuplexBodyPushResult =
  | { ok: true }
  | { ok: false; error: DuplexBodyError };

/**
 * A per-channel receive-side body reassembler. One instance serves one channel.
 * The caller feeds it one envelope per body, then the `body_chunk` frames for
 * that body. The reassembler reassembles the body on the memory path or the
 * spill path and settles one completion promise per body.
 */
export class DuplexBodyReceiver {
  private readonly spillThresholdBytes: number;
  private readonly rawChunkBytes: number;
  private readonly arena: SpillArena;
  private readonly logger?: (message: string) => void;
  private readonly active = new Map<string, ActiveBody>();

  private constructor(arena: SpillArena, config: DuplexBodyReceiverConfig) {
    this.arena = arena;
    this.spillThresholdBytes =
      config.spillThresholdBytes ?? DEFAULT_DUPLEX_BODY_SPILL_THRESHOLD_BYTES;
    this.rawChunkBytes = config.rawChunkBytes ?? DUPLEX_BODY_CHUNK_RAW_BYTES;
    this.logger = config.logger;
  }

  /**
   * Build a receiver. The receiver owns the spill directory. It creates the
   * directory with `mkdtemp` and mode 0700, then sweeps stale spill directories
   * from a prior process. The sweep runs and awaits before the receiver serves a
   * body, so no caller races a half-swept directory.
   */
  static async create(config: DuplexBodyReceiverConfig = {}): Promise<DuplexBodyReceiver> {
    const root = config.spillRootDir ?? os.tmpdir();
    await sweepStaleSpillDirectories(root, config.logger);
    const dir = await fs.mkdtemp(path.join(root, `${SPILL_DIR_PREFIX}${process.pid}-`));
    // `mkdtemp` creates the directory with mode 0700 on a POSIX host by default,
    // but a permissive umask can widen it. Set the mode so the owner alone reads,
    // writes, and lists the spill directory.
    await fs.chmod(dir, 0o700);
    const arena = new SpillArena(
      dir,
      config.channelSpillByteCap ?? DEFAULT_DUPLEX_CHANNEL_SPILL_BYTE_CAP,
      config.channelSpillFileCap ?? DEFAULT_DUPLEX_CHANNEL_SPILL_FILE_CAP,
    );
    return new DuplexBodyReceiver(arena, config);
  }

  /** The spill directory this receiver owns. A test reads it to assert containment and cleanup. */
  get spillDir(): string {
    return this.arena.dir;
  }

  /** The bytes on disk across all in-flight bodies for this channel. A test asserts the reservation. */
  get spillUsedBytes(): number {
    return this.arena.usedBytes;
  }

  /** The open spill files for this channel. A test asserts the file-slot reservation. */
  get spillOpenFiles(): number {
    return this.arena.openFiles;
  }

  /**
   * Begin one body. The caller passes the envelope `id` and `bodyByteCount`. The
   * receiver chooses the memory path or the spill path from `bodyByteCount`
   * before the first chunk arrives. A `bodyByteCount` of 0 completes at once with
   * an empty body and accepts no chunk. The returned promise resolves with the
   * reassembled body, or rejects with a {@link DuplexBodyError} on a terminal
   * protocol or resource error.
   */
  begin(id: string, bodyByteCount: number): Promise<ReassembledBody> {
    return new Promise<ReassembledBody>((resolve, reject) => {
      // A repeated envelope id for an in-flight body is a protocol violation. The
      // caller must not begin the same id twice. Reject the new begin and leave
      // the in-flight body untouched.
      if (this.active.has(id)) {
        reject(new DuplexBodyError("chunk_after_completion", "duplicate body envelope id"));
        return;
      }
      const body: ActiveBody = {
        bodyByteCount,
        nextSeq: 0,
        receivedBytes: 0,
        spilled: bodyByteCount > this.spillThresholdBytes,
        memoryChunks: [],
        filePath: null,
        handle: null,
        reservedBytes: 0,
        holdsFileSlot: false,
        disposed: false,
        resolve,
        reject,
        writeChain: Promise.resolve(),
        settled: false,
      };
      this.active.set(id, body);
      if (bodyByteCount === 0) {
        // The zero-length body completes at once. It accepts no chunk, so the
        // receiver keeps the id in a completed state to reject a stray chunk.
        this.complete(id, body);
        return;
      }
      if (body.spilled) {
        // Reserve one file slot before the receiver opens the spill file. A
        // reserve past the file cap fails closed at once.
        if (!this.arena.reserveFile()) {
          this.settleReject(id, body, new DuplexBodyError("spill_cap_exceeded", "spill file cap reached"));
          return;
        }
        body.holdsFileSlot = true;
        // Open the spill file with a random name and mode 0600. The name never
        // derives from the frame id, so no id rides a path. Verify the resolved
        // path stays inside the spill directory before the receiver writes.
        this.openSpillFile(id, body);
      }
    });
  }

  /**
   * Push one `body_chunk` frame. The receiver validates the chunk against the
   * in-flight body, then appends it on the memory path or the spill path. The
   * return value reports a synchronous validation outcome. A spill write failure
   * or a completion rejects the begin promise instead.
   */
  pushChunk(frame: DuplexBodyChunkFrame): DuplexBodyPushResult {
    const body = this.active.get(frame.id);
    if (!body) {
      return fail("chunk_without_envelope", "body_chunk arrived with no matching envelope");
    }
    if (body.bodyByteCount === 0) {
      return fail("zero_body_has_chunk", "a zero-length body accepts no body_chunk");
    }
    if (body.settled) {
      return fail("chunk_after_completion", "body_chunk arrived after the body completed");
    }
    if (frame.seq !== body.nextSeq) {
      return fail("seq_out_of_order", "body_chunk seq is a duplicate, a gap, or a reorder");
    }
    // Decode the base64 payload and confirm it is canonical. A non-canonical
    // payload re-encodes to a different string, so the round-trip catches it.
    const decoded = Buffer.from(frame.data, "base64");
    if (decoded.toString("base64") !== frame.data) {
      return fail("chunk_not_canonical_base64", "body_chunk data is not canonical base64");
    }
    if (decoded.length === 0) {
      return fail("empty_chunk", "body_chunk is empty");
    }
    const nextReceived = body.receivedBytes + decoded.length;
    if (nextReceived > body.bodyByteCount) {
      return fail("body_overrun", "body_chunk overruns the declared body size");
    }
    const isFinal = nextReceived === body.bodyByteCount;
    if (!isFinal && decoded.length !== this.rawChunkBytes) {
      // A non-final chunk must be exactly the fixed raw slice size. A short
      // non-final chunk is a truncation; an over-size chunk is a framing fault.
      return fail("chunk_wrong_size", "a non-final body_chunk is not the fixed slice size");
    }
    if (decoded.length > this.rawChunkBytes) {
      // The final chunk must also stay within the fixed raw slice size.
      return fail("chunk_wrong_size", "a body_chunk exceeds the fixed slice size");
    }
    body.nextSeq += 1;
    body.receivedBytes = nextReceived;
    if (body.spilled) {
      this.appendSpill(frame.id, body, decoded, isFinal);
    } else {
      body.memoryChunks.push(decoded);
      if (isFinal) this.complete(frame.id, body);
    }
    return { ok: true };
  }

  /**
   * Dispose one body by id, whatever its state. The dispose path unlinks the
   * spill file and releases the arena reservation exactly once. The caller runs
   * it on every settle path and on channel death, so a spill file never lingers.
   */
  async disposeBody(id: string): Promise<void> {
    const body = this.active.get(id);
    if (!body) return;
    this.active.delete(id);
    await this.release(body);
  }

  /**
   * Dispose every in-flight body. The caller runs it on channel death, so a
   * channel that dies mid-body leaves no spill file behind.
   */
  async disposeAll(): Promise<void> {
    const ids = [...this.active.keys()];
    await Promise.all(ids.map((id) => this.disposeBody(id)));
  }

  /**
   * Remove the spill directory this receiver owns. The caller runs it after it
   * disposes every body, on channel shutdown.
   */
  async destroy(): Promise<void> {
    await this.disposeAll();
    await fs.rm(this.arena.dir, { recursive: true, force: true }).catch(() => undefined);
  }

  private openSpillFile(id: string, body: ActiveBody): void {
    const name = `${randomBytes(24).toString("hex")}.body`;
    const filePath = path.join(this.arena.dir, name);
    // Path containment. The resolved file path must stay inside the spill
    // directory. A generated random name never escapes, but the check is defense
    // in depth against a future name scheme.
    const resolvedDir = path.resolve(this.arena.dir);
    const resolvedFile = path.resolve(filePath);
    if (resolvedFile !== path.join(resolvedDir, name) || !resolvedFile.startsWith(resolvedDir + path.sep)) {
      this.settleReject(id, body, new DuplexBodyError("path_escape", "spill path escapes the spill directory"));
      return;
    }
    body.filePath = filePath;
    // Open the file once, exclusive, mode 0600. The write chain appends each
    // chunk in order to this one handle.
    body.writeChain = body.writeChain.then(async () => {
      body.handle = await fs.open(filePath, "wx", 0o600);
    });
    body.writeChain.catch((error) => {
      this.settleReject(id, body, new DuplexBodyError("spill_write_failed", errorText(error)));
    });
  }

  private appendSpill(id: string, body: ActiveBody, decoded: Buffer, isFinal: boolean): void {
    // Reserve the bytes before the write. A reserve past the byte cap fails
    // closed: reject the body and unlink the partial file.
    if (!this.arena.reserveBytes(decoded.length)) {
      this.settleReject(id, body, new DuplexBodyError("spill_cap_exceeded", "spill byte cap reached"));
      return;
    }
    body.reservedBytes += decoded.length;
    body.writeChain = body.writeChain.then(async () => {
      if (body.settled) return;
      if (!body.handle) throw new Error("spill file handle is not open");
      await body.handle.write(decoded);
      if (isFinal) {
        await body.handle.close();
        body.handle = null;
        this.complete(id, body);
      }
    });
    body.writeChain.catch((error) => {
      if (error instanceof DuplexBodyError) return;
      this.settleReject(id, body, new DuplexBodyError("spill_write_failed", errorText(error)));
    });
  }

  private complete(id: string, body: ActiveBody): void {
    if (body.settled) return;
    body.settled = true;
    const receiver = this;
    const handle: ReassembledBody = {
      byteCount: body.bodyByteCount,
      spilled: body.spilled,
      readMemory(): Buffer {
        if (body.spilled) {
          throw new DuplexBodyError("spill_write_failed", "a spilled body has no in-memory buffer");
        }
        return Buffer.concat(body.memoryChunks);
      },
      createReadStream(): Readable {
        if (body.spilled && body.filePath) return createReadStream(body.filePath);
        return Readable.from(Buffer.concat(body.memoryChunks));
      },
      async dispose(): Promise<void> {
        await receiver.disposeBody(id);
      },
    };
    body.resolve(handle);
  }

  private settleReject(id: string, body: ActiveBody, error: DuplexBodyError): void {
    if (body.settled) return;
    body.settled = true;
    // Release the reservation and unlink the partial file before the reject, so
    // a rejected body never keeps a spill file or a reservation. The reject fires
    // after the release, so a caller that awaits the reject sees a clean arena.
    void this.disposeBody(id).finally(() => body.reject(error));
  }

  private async release(body: ActiveBody): Promise<void> {
    if (body.disposed) return;
    body.disposed = true;
    // Wait for the pending writes to settle, so the unlink never races an open
    // handle. Swallow a write error here; the reject path already reported it.
    await body.writeChain.catch(() => undefined);
    if (body.handle) {
      await body.handle.close().catch(() => undefined);
      body.handle = null;
    }
    if (body.filePath) {
      await fs.rm(body.filePath, { force: true }).catch((error) => {
        this.logger?.(`Duplex spill unlink failed: ${errorText(error)}`);
      });
    }
    if (body.reservedBytes > 0) {
      this.arena.releaseBytes(body.reservedBytes);
      body.reservedBytes = 0;
    }
    if (body.holdsFileSlot) {
      this.arena.releaseFile();
      body.holdsFileSlot = false;
    }
    // A body that the channel disposes before it settles must not leave its
    // begin promise pending. Reject it with a terminal channel-closed error, so
    // a caller that awaits the body sees the channel death. A body that already
    // settled keeps its outcome: `complete` resolves it, and `settleReject` sets
    // `settled` before it calls dispose, so this guard never double-settles.
    if (!body.settled) {
      body.settled = true;
      body.reject(
        new DuplexBodyError("channel_closed", "the channel closed before the body completed"),
      );
    }
  }
}

function fail(code: DuplexBodyErrorCode, message: string): DuplexBodyPushResult {
  return { ok: false, error: new DuplexBodyError(code, message) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Split a whole body buffer into `body_chunk` frames. The send side reads the
 * source body once, then calls this to build the frames. Each frame carries one
 * raw slice of `rawChunkBytes` as base64 text, except the final frame, which
 * carries the remaining bytes. A zero-length body yields no frame.
 */
export function splitBodyIntoChunkFrames(
  id: string,
  body: Buffer,
  version: number,
  rawChunkBytes: number = DUPLEX_BODY_CHUNK_RAW_BYTES,
): DuplexBodyChunkFrame[] {
  const frames: DuplexBodyChunkFrame[] = [];
  let seq = 0;
  for (let offset = 0; offset < body.length; offset += rawChunkBytes) {
    const slice = body.subarray(offset, offset + rawChunkBytes);
    frames.push({
      version,
      type: "body_chunk",
      id,
      seq,
      data: slice.toString("base64"),
    });
    seq += 1;
  }
  return frames;
}

/**
 * Sweep stale spill directories from a prior process. The receiver runs it at
 * startup, before it serves a body. It removes a spill directory whose embedded
 * pid is not this process and is not a live process, so a crash that left a
 * directory behind does not leak disk. It never removes a directory of a live
 * process, so a concurrent channel keeps its own spill directory.
 */
export async function sweepStaleSpillDirectories(
  root: string,
  logger?: (message: string) => void,
): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith(SPILL_DIR_PREFIX)) return;
      const pid = parsePidFromSpillDir(entry.name);
      if (pid !== null && pid !== process.pid && isProcessAlive(pid)) return;
      if (pid === process.pid) return;
      await fs.rm(path.join(root, entry.name), { recursive: true, force: true }).catch((error) => {
        logger?.(`Duplex stale spill sweep failed: ${errorText(error)}`);
      });
    }),
  );
}

/** Read the pid segment from a spill directory name, or null when it is absent. */
function parsePidFromSpillDir(name: string): number | null {
  const rest = name.slice(SPILL_DIR_PREFIX.length);
  const dash = rest.indexOf("-");
  const pidText = dash === -1 ? rest : rest.slice(0, dash);
  const pid = Number(pidText);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Return true when a process with the pid is alive. A signal 0 probes without a real signal. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this process cannot signal it. ESRCH
    // means no such process. Treat only ESRCH as dead.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
