import { Worker } from "node:worker_threads";

/**
 * Digests and AES-256-GCM passes over whole files, run on worker threads.
 *
 * Hashing and ciphering are synchronous in Node: on the server's thread every
 * megabyte of a saved workspace delays every request and agent turn behind it.
 * A job here names files and byte ranges, never file contents, so a waiting
 * job holds no data. At most `FILE_CRYPTO_WORKER_LIMIT` jobs run at once, each
 * with two reused read buffers; the rest wait in order and can be cancelled.
 */
export const FILE_CRYPTO_WORKER_LIMIT = 2;

export interface FileDigestRequest {
  /** The file to read, or `fd` for a file the caller already holds open. */
  file?: string;
  fd?: number;
  /** First and last byte to read, both inclusive. Defaults to the whole file. */
  start?: number;
  end?: number;
  algorithm: "sha256" | "md5";
  /** Also writes exactly the digested bytes to this new private file. */
  copyTo?: string;
}
export interface FileDigest { hex: string; bytes: number }

export interface FileEncryptRequest {
  source: string;
  /** Created here, owner-only: `prefix`, then the ciphertext, then the 16-byte tag. */
  target: string;
  prefix: Uint8Array;
  key: Uint8Array;
  iv: Uint8Array;
  aad: Uint8Array;
}
export interface FileEncryption {
  plaintextSha256: string; plaintextBytes: number;
  /** Digest and size of everything written to `target`. */
  sha256: string; byteSize: number;
}

export interface FileDecryptRequest {
  source: string;
  /** Created here, owner-only. Holds unauthenticated bytes until the result says otherwise. */
  target: string;
  /** First ciphertext byte, and the byte after the last one. */
  start: number;
  end: number;
  key: Uint8Array;
  iv: Uint8Array;
  aad: Uint8Array;
  authTag: Uint8Array;
}
export interface FileDecryption {
  /** Set when the ciphertext, key, additional data or tag did not authenticate. */
  authenticationFailure?: { message: string; code?: string };
}

type Job = ({ kind: "digest" } & FileDigestRequest) | ({ kind: "encrypt" } & FileEncryptRequest) | ({ kind: "decrypt" } & FileDecryptRequest);
type WorkerRequest = { id: number; job: Job; cancel: Int32Array };
type WorkerReply = { id: number; result?: unknown; cancelled?: true;
  error?: { name?: string; message: string; code?: string; errno?: number; syscall?: string; path?: string } };

/**
 * The worker thread's whole program. It is sent as source text, so it may use
 * only its `require` argument and JavaScript built-ins, never this module's
 * bindings. One job runs at a time, through two reused read buffers.
 */
function fileCryptoWorker(require: NodeJS.Require): void {
  const { parentPort } = require("node:worker_threads") as typeof import("node:worker_threads");
  const fs = require("node:fs") as typeof import("node:fs");
  const crypto = require("node:crypto") as typeof import("node:crypto");
  const { promisify } = require("node:util") as typeof import("node:util");
  const readFrom = promisify(fs.read), writeTo = promisify(fs.write);
  const chunks = [Buffer.allocUnsafe(1024 * 1024), Buffer.allocUnsafe(1024 * 1024)];
  const cancelled = {};
  const bytes = (value: Uint8Array) => Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const writeAll = async (fd: number, data: Uint8Array) => {
    for (let offset = 0; offset < data.length;) offset += (await writeTo(fd, data, offset, data.length - offset, null)).bytesWritten;
  };
  /**
   * Reads `[start, end)` of `input` in order, up to the end of the file, and
   * writes what `each` returns for every chunk to `output`, in the same order.
   * Without a `start` it reads on from the descriptor's own position, as the
   * stream it replaces did. One write is in flight while the next chunk is
   * read and processed, so the disk and this thread work at the same time.
   */
  const pump = async (input: number, start: number | undefined, end: number, cancel: Int32Array, output: number | undefined,
    each: (part: Buffer) => Uint8Array) => {
    const first = start ?? 0;
    let position = first, turn = 0, writing = Promise.resolve(), written: ArrayBufferLike | undefined;
    try {
      while (position < end) {
        if (Atomics.load(cancel, 0) !== 0) throw cancelled;
        const chunk = chunks[turn]!; turn ^= 1;
        // A copy writes the read buffer itself: never read into one still being written.
        if (written === chunk.buffer) await writing;
        const { bytesRead } = await readFrom(input, chunk, 0, Math.min(chunk.length, end - position), start === undefined ? null : position);
        if (bytesRead === 0) break;
        const data = each(chunk.subarray(0, bytesRead));
        position += bytesRead;
        if (output === undefined || data.length === 0) continue;
        await writing;
        writing = writeAll(output, data); written = data.buffer;
        // A failure is reported by the next `await writing`, not as an unhandled rejection.
        writing.catch(() => undefined);
      }
      await writing;
    } catch (error) {
      // No file is closed while a write to it is still in flight.
      await writing.catch(() => undefined);
      throw error;
    }
    return position - first;
  };
  const close = (fd: number | undefined) => { if (fd !== undefined) fs.closeSync(fd); };
  const run = async (job: Job, cancel: Int32Array): Promise<unknown> => {
    let input: number | undefined, output: number | undefined;
    try {
      if (job.kind === "digest") {
        input = job.fd ?? fs.openSync(job.file!, "r");
        if (job.copyTo !== undefined) output = fs.openSync(job.copyTo, "wx", 0o600);
        const digest = crypto.createHash(job.algorithm);
        const count = await pump(input, job.start, job.end === undefined ? Infinity : job.end + 1, cancel, output, part => {
          digest.update(part);
          return part;
        });
        return { hex: digest.digest("hex"), bytes: count };
      }
      const key = bytes(job.key);
      try {
        input = fs.openSync(job.source, "r");
        const target = output = fs.openSync(job.target, "wx", 0o600);
        if (job.kind === "encrypt") {
          const plaintext = crypto.createHash("sha256"), stored = crypto.createHash("sha256");
          const cipher = crypto.createCipheriv("aes-256-gcm", key, bytes(job.iv));
          cipher.setAAD(bytes(job.aad));
          let byteSize = 0;
          const store = (data: Uint8Array) => { stored.update(data); byteSize += data.length; return data; };
          await writeAll(target, store(bytes(job.prefix)));
          const plaintextBytes = await pump(input, undefined, Infinity, cancel, target, part => { plaintext.update(part); return store(cipher.update(part)); });
          await writeAll(target, store(cipher.final()));
          await writeAll(target, store(cipher.getAuthTag()));
          return { plaintextSha256: plaintext.digest("hex"), plaintextBytes, sha256: stored.digest("hex"), byteSize };
        }
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes(job.iv));
        decipher.setAAD(bytes(job.aad)); decipher.setAuthTag(bytes(job.authTag));
        await pump(input, job.start, job.end, cancel, target, part => decipher.update(part));
        let last: Buffer | undefined, authenticationFailure: { message: string; code?: string } | undefined;
        try { last = decipher.final(); }
        catch (error) { authenticationFailure = { message: (error as Error).message, code: (error as NodeJS.ErrnoException).code }; }
        if (last) await writeAll(target, last);
        return { authenticationFailure };
      } finally { key.fill(0); }
    } finally {
      // A caller's own descriptor stays open for the caller to close.
      try { close(output); } finally { if (job.kind !== "digest" || job.fd === undefined) close(input); }
    }
  };
  parentPort!.on("message", (request: WorkerRequest) => {
    run(request.job, request.cancel).then((result): WorkerReply => ({ id: request.id, result }), (error): WorkerReply => {
      const failure = error as NodeJS.ErrnoException;
      return error === cancelled ? { id: request.id, cancelled: true } : { id: request.id, error: { name: failure?.name,
        message: String(failure?.message ?? error), code: failure?.code, errno: failure?.errno, syscall: failure?.syscall, path: failure?.path } };
    }).then(reply => parentPort!.postMessage(reply));
  });
}

// `__name` is a helper some TypeScript loaders wrap around nested functions.
const WORKER_SOURCE = `const __name = value => value;\n(${fileCryptoWorker.toString()})(require);`;

type Pending = {
  id: number; job: Job; cancel: Int32Array; signal?: AbortSignal; onAbort?: () => void;
  resolve: (result: unknown) => void; reject: (error: unknown) => void;
};
const queue: Pending[] = [];
const idle: Worker[] = [];
const running = new Map<Worker, Pending>();
let nextId = 0;

/** What a cancelled stream pipeline rejects with, so callers see the same failure as before. */
function abortError(signal: AbortSignal) {
  return Object.assign(new Error("The operation was aborted", { cause: signal.reason }), { name: "AbortError", code: "ABORT_ERR" });
}

const secret = (job: Job) => (job.kind === "digest" ? undefined : job.key);

function settle(pending: Pending) {
  if (pending.onAbort) pending.signal!.removeEventListener("abort", pending.onAbort);
  // A key that never reached a worker is still this thread's copy to erase.
  const key = secret(pending.job);
  if (key && key.byteLength > 0) key.fill(0);
}

function release(worker: Worker, healthy: boolean) {
  running.delete(worker);
  if (healthy) { worker.unref(); idle.push(worker); }
  else void worker.terminate();
  dispatch();
}

function spawn() {
  const worker = new Worker(WORKER_SOURCE, { eval: true, execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
  const fail = (error: Error) => {
    const index = idle.indexOf(worker);
    if (index >= 0) idle.splice(index, 1);
    const pending = running.get(worker);
    if (!pending && index < 0) return;
    if (pending) { settle(pending); pending.reject(error); }
    release(worker, false);
  };
  worker.on("message", (reply: WorkerReply) => {
    const pending = running.get(worker);
    if (!pending || pending.id !== reply.id) return;
    settle(pending);
    if (reply.cancelled) pending.reject(abortError(pending.signal!));
    else if (reply.error) pending.reject(Object.assign(new Error(reply.error.message), reply.error));
    else pending.resolve(reply.result);
    release(worker, true);
  });
  worker.on("error", fail);
  worker.on("exit", () => fail(new Error("file_crypto_worker_exited")));
  return worker;
}

function dispatch() {
  while (queue.length && (idle.length || running.size < FILE_CRYPTO_WORKER_LIMIT)) {
    const pending = queue.shift()!;
    let worker: Worker;
    try { worker = idle.pop() ?? spawn(); }
    catch (error) { settle(pending); pending.reject(error); continue; }
    worker.ref();
    running.set(worker, pending);
    const key = secret(pending.job);
    try { worker.postMessage({ id: pending.id, job: pending.job, cancel: pending.cancel } satisfies WorkerRequest, key ? [key.buffer as ArrayBuffer] : []); }
    catch (error) { settle(pending); pending.reject(error); release(worker, false); }
  }
}

function submit<T>(job: Job, signal: AbortSignal | undefined): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const pending: Pending = { id: nextId++, job, cancel: new Int32Array(new SharedArrayBuffer(4)), signal,
      resolve: resolve as (result: unknown) => void, reject };
    if (signal?.aborted) { settle(pending); reject(abortError(signal)); return; }
    if (signal) {
      pending.onAbort = () => {
        const index = queue.indexOf(pending);
        // A running job stops at its next chunk and answers once its files are closed.
        if (index < 0) { Atomics.store(pending.cancel, 0, 1); return; }
        queue.splice(index, 1); settle(pending); reject(abortError(signal));
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
    }
    queue.push(pending);
    dispatch();
  });
}

/** Jobs running and waiting right now. */
export function fileCryptoPoolLoad() {
  return { running: running.size, waiting: queue.length };
}

export function digestFileOffThread(request: FileDigestRequest, signal?: AbortSignal): Promise<FileDigest> {
  return submit({ kind: "digest", ...request }, signal);
}

// Each byte array is copied to its exact size, so nothing else that shares its
// allocation crosses to the worker. The key's copy is moved, not cloned.
const exact = (value: Uint8Array) => new Uint8Array(value);

/** The worker erases its copy of `key`; the caller's stays the caller's to erase. */
export function encryptFileOffThread(request: FileEncryptRequest, signal?: AbortSignal): Promise<FileEncryption> {
  return submit({ kind: "encrypt", ...request, prefix: exact(request.prefix), key: exact(request.key), iv: exact(request.iv),
    aad: exact(request.aad) }, signal);
}

/** The worker erases its copy of `key`; the caller's stays the caller's to erase. */
export function decryptFileOffThread(request: FileDecryptRequest, signal?: AbortSignal): Promise<FileDecryption> {
  return submit({ kind: "decrypt", ...request, key: exact(request.key), iv: exact(request.iv), aad: exact(request.aad),
    authTag: exact(request.authTag) }, signal);
}
