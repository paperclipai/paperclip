/**
 * Disk-backed spooling for issue attachment uploads.
 *
 * Every other upload path in the server uses `multer.memoryStorage()`, which
 * puts the whole request body on the Node heap for the duration of the request.
 * That is the right trade at 10 MB and the wrong one at 512 MB: a handful of
 * concurrent 70 MB episode uploads would be 350 MB of resident heap on a
 * process that also runs every agent adapter.
 *
 * This module gives the issue attachment path a `multer.diskStorage`
 * destination instead, so peak memory is O(multer's 64 KB stream chunk) and the
 * cost of a large upload is transient disk equal to the file size. The spool is
 * released as soon as the object has been stored; `release` is also the safety
 * net for every earlier exit, including validation failures and size-limit
 * rejections.
 *
 * A per-request ceiling does not bound N concurrent requests, so this module
 * also owns an aggregate disk budget (`admit`) and an explicit liveness registry
 * for the sweeper. Both are process-scoped: the budget is enforced by the one
 * router instance that accepts uploads, and the liveness registry is shared
 * because the hourly sweeper builds its own spooler.
 *
 * See `doc/plans/2026-10-04-issue-attachment-size-ceilings.md`.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs, type Dirent, type ReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request, Response } from "express";
import { MAX_ISSUE_ATTACHMENT_BYTES } from "../attachment-types.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const SPOOL_DIRNAME = "attachment-uploads";

/**
 * How long an orphan spool directory may survive before it is swept. The normal
 * lifecycle is sub-second (write -> store -> unlink), so anything older than
 * this is the residue of a crashed or SIGKILLed server, or of a failed cleanup.
 *
 * Liveness is tracked explicitly in {@link activeSpoolDirs} rather than inferred
 * from the directory's mtime, so this no longer has to be comfortably longer than
 * a legitimate large upload: the sweep skips in-flight directories outright.
 */
const SPOOL_SWEEP_AGE_MS = 60 * 60 * 1000;

/**
 * Aggregate disk budget for in-flight issue attachment uploads.
 *
 * Defaults to one full-size upload — the most conservative value that still lets
 * a single large deliverable through. An operator with disk to spare raises it
 * with `PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES`; the cost of a raised
 * budget is transient spool disk, not resident heap.
 */
const DEFAULT_MAX_INFLIGHT_SPOOL_BYTES = MAX_ISSUE_ATTACHMENT_BYTES;

/**
 * Spool directories owned by a live request in this process.
 *
 * Module-scoped on purpose: `startAttachmentUploadSpoolSweeper` constructs its
 * own spooler, and that sweeper must see uploads admitted through the router's
 * spooler. Entries disappear on `release`, so after a crash the registry starts
 * empty and every leftover directory is genuinely orphaned.
 */
const activeSpoolDirs = new Set<string>();

export type AttachmentUploadAdmission =
  | { admitted: true; inFlightBytes: number; maxInFlightBytes: number }
  | {
      admitted: false;
      inFlightBytes: number;
      maxInFlightBytes: number;
      /** Seconds a rejected client should wait before retrying. */
      retryAfterSeconds: number;
    };

export interface AttachmentUploadSpoolOptions {
  /**
   * Aggregate disk budget for in-flight uploads. Defaults to one full-size
   * upload, or `PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES` when set.
   */
  maxInFlightBytes?: number;
}

export interface AttachmentUploadSpooler {
  /** Root directory that holds every in-flight upload directory. */
  readonly root: string;
  /** Aggregate disk budget enforced by {@link admit}. */
  readonly maxInFlightBytes: number;
  /** Bytes currently reserved by in-flight uploads. */
  readonly inFlightBytes: number;
  /**
   * Reserve aggregate spool budget for a request, before multer writes a byte.
   * Returns `admitted: false` instead of throwing so the route can answer with a
   * retryable status. Reservation is released by {@link release}.
   */
  admit: (request: Request, response?: Response) => AttachmentUploadAdmission;
  /** `multer.diskStorage` destination callback. */
  destination: (req: Request, file: unknown, cb: (err: Error | null, dir: string) => void) => void;
  /** Delete one request's spool directory and free its reservation. Idempotent. */
  release(request: Request): Promise<void>;
  /** Delete spool directories left behind by crashed runs and failed cleanups. */
  sweepOrphans(nowMs?: number): Promise<string[]>;
}

export function resolveAttachmentUploadSpoolRoot(): string {
  return path.join(resolvePaperclipInstanceRoot(), "data", SPOOL_DIRNAME);
}

/**
 * Remove a spool directory, reporting failure instead of swallowing it.
 *
 * A failed cleanup leaves user content pinned on the instance volume, so it has
 * to be visible in the log even though the request itself succeeded. The hourly
 * sweep is the retry: it skips directories that are still in flight, so anything
 * left behind here is genuinely abandoned.
 */
async function removeSpoolDir(target: string): Promise<boolean> {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch (error) {
    logger.warn(
      { err: error, spoolDir: target },
      "failed to remove issue attachment spool directory; the orphan sweep will retry",
    );
    return false;
  }
}

/**
 * Bytes to reserve for a request's spool.
 *
 * The declared `Content-Length` of the multipart body is an upper bound on the
 * file part, so it is the right number to reserve. A chunked request has no
 * length to trust, so it reserves the full per-request ceiling — the conservative
 * direction, because over-reserving only delays the next upload.
 */
function reservationBytesFor(request: Request): number {
  const header = request.headers?.["content-length"];
  const declared = Array.isArray(header) ? Number(header[0]) : Number(header);
  if (Number.isSafeInteger(declared) && declared > 0) {
    return Math.min(declared, MAX_ISSUE_ATTACHMENT_BYTES);
  }
  return MAX_ISSUE_ATTACHMENT_BYTES;
}

export function createAttachmentUploadSpooler(
  root: string = resolveAttachmentUploadSpoolRoot(),
  options: AttachmentUploadSpoolOptions = {},
): AttachmentUploadSpooler {
  const spoolRoot = path.resolve(root);
  const envBudget = Number(process.env.PAPERCLIP_ISSUE_ATTACHMENT_MAX_INFLIGHT_BYTES);
  const requestedBudget = options.maxInFlightBytes ?? envBudget;
  const budget =
    Number.isSafeInteger(requestedBudget) && requestedBudget > 0
      ? requestedBudget
      : DEFAULT_MAX_INFLIGHT_SPOOL_BYTES;

  // multer only populates `req.file` on success, so the directory it created is
  // tracked here too — otherwise a `LIMIT_FILE_SIZE` abort would leak the
  // directory until the orphan sweep. A WeakMap keyed on the request keeps
  // the entry collectable as soon as the response is done.
  const dirByRequest = new WeakMap<Request, string>();
  const reservedByRequest = new WeakMap<Request, number>();
  let inFlightBytes = 0;

  const free = (request: Request): void => {
    const reserved = reservedByRequest.get(request);
    if (reserved === undefined) return;
    reservedByRequest.delete(request);
    inFlightBytes = Math.max(0, inFlightBytes - reserved);
  };

  return {
    root: spoolRoot,
    maxInFlightBytes: budget,

    get inFlightBytes(): number {
      return inFlightBytes;
    },

    admit(request: Request, response?: Response): AttachmentUploadAdmission {
      if (reservedByRequest.has(request)) {
        return { admitted: true, inFlightBytes, maxInFlightBytes: budget };
      }
      const requested = reservationBytesFor(request);
      if (inFlightBytes + requested > budget) {
        logger.warn(
          { inFlightBytes, requested, maxInFlightBytes: budget },
          "rejected issue attachment upload: aggregate spool budget exhausted",
        );
        return {
          admitted: false,
          inFlightBytes,
          maxInFlightBytes: budget,
          retryAfterSeconds: 5,
        };
      }

      inFlightBytes += requested;
      reservedByRequest.set(request, requested);
      // Backstop: if the handler never reaches its `finally`, a closed response
      // still frees the reservation so the budget cannot leak across requests.
      response?.once("close", () => {
        free(request);
        const dir = dirByRequest.get(request);
        if (dir) {
          dirByRequest.delete(request);
          activeSpoolDirs.delete(dir);
          void removeSpoolDir(dir);
        }
      });
      return { admitted: true, inFlightBytes, maxInFlightBytes: budget };
    },

    destination(req: Request, _file: unknown, cb: (err: Error | null, dir: string) => void): void {
      // `randomUUID` rather than a request-derived id: the directory name lands
      // on disk, so it must not be guessable from a user-controlled header.
      const dir = path.join(spoolRoot, randomUUID());
      dirByRequest.set(req, dir);
      activeSpoolDirs.add(dir);
      fs.mkdir(dir, { recursive: true })
        .then(() => cb(null, dir))
        .catch((err: unknown) => {
          // Never created, so nothing is in flight and nothing needs sweeping.
          activeSpoolDirs.delete(dir);
          dirByRequest.delete(req);
          cb(err as Error, dir);
        });
    },

    async release(request: Request): Promise<void> {
      free(request);
      const file = (request as Request & { file?: { path?: string } }).file;
      // `file.path` is `<dir>/upload`; removing the parent drops the whole
      // request's spool in one call. Fall back to the tracked dir when multer
      // aborted before setting `file`.
      const tracked = dirByRequest.get(request);
      const dir = file?.path ? path.dirname(file.path) : tracked;
      if (!dir) return;
      if (path.dirname(dir) !== spoolRoot) return;
      dirByRequest.delete(request);
      // Drop the liveness entry even when the delete fails: the upload is over,
      // so the leftover is an orphan the sweep is allowed to retry.
      activeSpoolDirs.delete(dir);
      await removeSpoolDir(dir);
    },

    async sweepOrphans(nowMs: number = Date.now()): Promise<string[]> {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(spoolRoot, { withFileTypes: true });
      } catch {
        return [];
      }

      const removed: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(spoolRoot, entry.name);
        // A directory's mtime does not advance while a file inside it is being
        // written or read, so age alone cannot distinguish "slow upload" from
        // "abandoned". The in-flight registry can, so it decides first.
        if (activeSpoolDirs.has(dir)) continue;
        try {
          const stats = await fs.stat(dir);
          if (nowMs - stats.mtimeMs < SPOOL_SWEEP_AGE_MS) continue;
        } catch {
          continue;
        }
        if (await removeSpoolDir(dir)) removed.push(dir);
      }
      return removed;
    },
  };
}

/**
 * Sweep on process start and then hourly. Orphan spools only exist after a hard
 * crash, so a lazy sweep is fine; the interval just bounds how long a crashed
 * instance leaves disk pinned.
 */
export function startAttachmentUploadSpoolSweeper(
  spooler: AttachmentUploadSpooler = createAttachmentUploadSpooler(),
  intervalMs: number = 60 * 60 * 1000,
): { stop: () => void } {
  void spooler.sweepOrphans();
  const timer = setInterval(() => {
    void spooler.sweepOrphans();
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Create the stream multer hands to the storage service for the spooled file. */
export function createSpooledAttachmentStream(filePath: string): ReadStream {
  return createReadStream(filePath);
}

/**
 * SHA-256 of a spooled file, computed from disk.
 *
 * `PutFileInput` requires an exact `byteSize` and `sha256` for a streamed body
 * so the storage service can reject a truncated stream before it records an
 * attachment row. multer already knows the size, but nothing upstream hashes
 * what it wrote, so the digest comes from this extra pass. It reads the file,
 * not the heap, so peak memory stays at one stream chunk.
 */
export async function hashSpooledAttachmentFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}
