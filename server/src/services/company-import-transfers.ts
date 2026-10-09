import { promises as fs } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { companyTransferRunService } from "./company-transfer-runs.js";

// Disk spool for chunked resumable company imports. The client slices its
// existing import .zip into byte-range parts and uploads them one at a time;
// each verified part is spooled at
//
//   <instance root>/import-transfers/<runId>/part-<index>
//
// until apply assembles them back into the original zip. The layout follows
// the other per-instance state dirs that live directly under the instance root
// (telemetry/, runtime-services/, skills/, data/run-logs/); like those
// siblings it needs no backup/export exclusion wiring — database backups dump
// embedded Postgres, they do not walk the instance root tree.

/** Spool dirs with no upload/apply activity for this long are abandoned. */
export const IMPORT_TRANSFER_SPOOL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** How often the abandoned-spool sweep runs. */
export const IMPORT_TRANSFER_SPOOL_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveDefaultImportTransferSpoolRoot(): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "import-transfers");
}

/**
 * Transfer run ids come from request URLs and are joined into filesystem
 * paths, so they are accepted only as canonical UUIDs — anything else (path
 * separators, dots, empty segments) is rejected before any path is built.
 */
export function isImportTransferRunId(value: string): boolean {
  return UUID_RE.test(value);
}

export function importTransferPartName(index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Invalid import transfer part index: ${String(index)}`);
  }
  return `part-${index}`;
}

function spoolDirFor(spoolRoot: string, runId: string): string {
  if (!isImportTransferRunId(runId)) {
    throw new Error("Invalid import transfer run id");
  }
  return path.join(spoolRoot, runId);
}

function partPathFor(spoolRoot: string, runId: string, index: number): string {
  return path.join(spoolDirFor(spoolRoot, runId), importTransferPartName(index));
}

/** Atomic part write: temp file in the same dir, then rename over the target. */
export async function writeImportTransferPart(
  spoolRoot: string,
  runId: string,
  index: number,
  bytes: Buffer,
): Promise<void> {
  const target = partPathFor(spoolRoot, runId, index);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tempPath = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tempPath, bytes);
  await fs.rename(tempPath, target);
}

/** Byte size of a spooled part, or null when it is missing (or not a file). */
export async function importTransferPartSizeOnDisk(
  spoolRoot: string,
  runId: string,
  index: number,
): Promise<number | null> {
  try {
    const stat = await fs.stat(partPathFor(spoolRoot, runId, index));
    return stat.isFile() ? stat.size : null;
  } catch {
    return null;
  }
}

/**
 * Concatenate the spooled parts, in index order, back into the original zip.
 * The full-zip buffer this produces exists only for the duration of an apply —
 * the same memory profile as the single-shot zip upload path.
 */
export async function assembleImportTransferZip(
  spoolRoot: string,
  runId: string,
  partCount: number,
): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for (let index = 0; index < partCount; index += 1) {
    buffers.push(await fs.readFile(partPathFor(spoolRoot, runId, index)));
  }
  return Buffer.concat(buffers);
}

export async function removeImportTransferSpool(spoolRoot: string, runId: string): Promise<void> {
  await fs.rm(spoolDirFor(spoolRoot, runId), { recursive: true, force: true });
}

/**
 * Remove one spooled part file. Used to discard a stray part written for a
 * run that turned out to be dead (e.g. expired by the sweep mid-upload).
 */
export async function removeImportTransferPart(
  spoolRoot: string,
  runId: string,
  index: number,
): Promise<void> {
  await fs.rm(partPathFor(spoolRoot, runId, index), { force: true });
}

/**
 * Delete spool dirs whose transfer saw no activity for `maxAgeMs` and cancel
 * their still-open ledger runs. A run-backed spool is only deleted after an
 * atomic claim: one guarded UPDATE cancels the run while it is still open
 * (pending/running) AND its `updatedAt` (every part upload and resume bumps
 * it) is still older than the cutoff — so a transfer that resumed after this
 * sweep read the run makes the guard miss and keeps its spool. The claim
 * cancels rather than fails on purpose: a failed run would still be claimable
 * by `claimApply`, letting an apply assemble the spool while this sweep
 * deletes it; a cancelled run is unclaimable the instant the UPDATE commits,
 * before any file is removed. Terminal runs keep their status and their spool
 * (a failed run's verified parts stay reusable for an apply retry; a
 * completed run's spool was already removed at apply). Orphan dirs with no
 * run row fall back to the dir's mtime — no run means no upload can race the
 * delete. A swept run is never resumed: `resumeOrCreate` ignores cancelled
 * runs, so redeclaring the same content starts a fresh run with every part
 * missing — matching the 410 "re-create it" a part upload against the swept
 * run gets.
 */
export async function sweepAbandonedImportTransferSpools(
  db: Db,
  spoolRoot: string,
  options: { maxAgeMs?: number; now?: Date } = {},
): Promise<{ swept: number }> {
  const maxAgeMs = options.maxAgeMs ?? IMPORT_TRANSFER_SPOOL_MAX_AGE_MS;
  const nowMs = (options.now ?? new Date()).getTime();
  const cutoff = new Date(nowMs - maxAgeMs);
  let entries;
  try {
    entries = await fs.readdir(spoolRoot, { withFileTypes: true });
  } catch {
    return { swept: 0 };
  }
  let swept = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isImportTransferRunId(entry.name)) continue;
    const runId = entry.name;
    const run = await companyTransferRunService.getRun(db, runId).catch(() => null);
    if (run) {
      if (run.status === "completed" || run.status === "cancelled") {
        // Terminal runs never assemble again; a leftover spool (e.g. a
        // best-effort post-apply cleanup that failed) is pure garbage and is
        // collected immediately, regardless of idle time.
      } else {
        const claimed = await companyTransferRunService.cancelIfIdle(
          db,
          runId,
          cutoff,
          "Abandoned import transfer: spooled parts were deleted after prolonged inactivity.",
        );
        if (!claimed) continue;
      }
    } else {
      let mtimeMs: number;
      try {
        mtimeMs = (await fs.stat(path.join(spoolRoot, runId))).mtimeMs;
      } catch {
        continue;
      }
      if (nowMs - mtimeMs <= maxAgeMs) continue;
    }
    await fs.rm(path.join(spoolRoot, runId), { recursive: true, force: true });
    swept += 1;
  }
  return { swept };
}
