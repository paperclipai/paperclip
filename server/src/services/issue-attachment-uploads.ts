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
 * See `doc/plans/2026-10-04-issue-attachment-size-ceilings.md`.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs, type Dirent, type ReadStream } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Request } from "express";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const SPOOL_DIRNAME = "attachment-uploads";

/**
 * How long an orphan spool directory may survive before it is swept. The normal
 * lifecycle is sub-second (write -> store -> unlink), so anything older than
 * this is the residue of a crashed or SIGKILLed server.
 */
const SPOOL_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

export interface AttachmentUploadSpooler {
  /** Root directory that holds every in-flight upload directory. */
  readonly root: string;
  /** `multer.diskStorage` destination callback. */
  destination: (req: Request, file: unknown, cb: (err: Error | null, dir: string) => void) => void;
  /** Delete one request's spool directory. Safe to call more than once. */
  release(request: Request): Promise<void>;
  /** Delete spool directories left behind by crashed runs. */
  sweepOrphans(nowMs?: number): Promise<string[]>;
}

export function resolveAttachmentUploadSpoolRoot(): string {
  return path.join(resolvePaperclipInstanceRoot(), "data", SPOOL_DIRNAME);
}

async function removeQuietly(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
}

export function createAttachmentUploadSpooler(
  root: string = resolveAttachmentUploadSpoolRoot(),
): AttachmentUploadSpooler {
  const spoolRoot = path.resolve(root);

  // multer only populates `req.file` on success, so the directory it created is
  // tracked here too — otherwise a `LIMIT_FILE_SIZE` abort would leak the
  // directory until the 24h orphan sweep. A WeakMap keyed on the request keeps
  // the entry collectable as soon as the response is done.
  const dirByRequest = new WeakMap<Request, string>();

  return {
    root: spoolRoot,

    destination(req: Request, _file: unknown, cb: (err: Error | null, dir: string) => void): void {
      // `randomUUID` rather than a request-derived id: the directory name lands
      // on disk, so it must not be guessable from a user-controlled header.
      const dir = path.join(spoolRoot, randomUUID());
      dirByRequest.set(req, dir);
      fs.mkdir(dir, { recursive: true })
        .then(() => cb(null, dir))
        .catch((err: unknown) => cb(err as Error, dir));
    },

    async release(request: Request): Promise<void> {
      const file = (request as Request & { file?: { path?: string } }).file;
      // `file.path` is `<dir>/upload`; removing the parent drops the whole
      // request's spool in one call. Fall back to the tracked dir when multer
      // aborted before setting `file`.
      const tracked = dirByRequest.get(request);
      const dir = file?.path ? path.dirname(file.path) : tracked;
      if (!dir) return;
      if (path.dirname(dir) !== spoolRoot) return;
      await removeQuietly(dir);
      dirByRequest.delete(request);
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
        try {
          const stats = await fs.stat(dir);
          if (nowMs - stats.mtimeMs < SPOOL_SWEEP_AGE_MS) continue;
        } catch {
          continue;
        }
        await removeQuietly(dir);
        removed.push(dir);
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
