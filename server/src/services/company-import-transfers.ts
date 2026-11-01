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

const spoolListeners = new Set<(root: string, runId: string) => void>();

export function onImportTransferSpoolChange(listener: (root: string, runId: string) => void): () => void {
  spoolListeners.add(listener);
  return () => { spoolListeners.delete(listener); };
}

function changed(spoolRoot: string, runId: string) {
  for (const listener of spoolListeners) listener(path.resolve(spoolRoot), runId);
}



export async function writeImportTransferPart(
  spoolRoot: string,
  runId: string,
  index: number,
  bytes: Buffer,
): Promise<void> {
  const target = partPathFor(spoolRoot, runId, index);
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tempPath = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await fs.writeFile(tempPath, bytes);
    await fs.rename(tempPath, target);
  } finally {

    changed(spoolRoot, runId);
  }
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
  const dir = spoolDirFor(spoolRoot, runId);
  try { await fs.rm(dir, { recursive: true, force: true }); }
  finally { changed(spoolRoot, runId); }
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
  const target = partPathFor(spoolRoot, runId, index);
  try { await fs.rm(target, { force: true }); }
  finally { changed(spoolRoot, runId); }
}


export async function listImportTransferSpools(spoolRoot: string): Promise<string[]> {
  try {
    return (await fs.readdir(spoolRoot, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && isImportTransferRunId(entry.name)).map(entry => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function readImportTransferSpool(db: Db, spoolRoot: string, runId: string) {
  let stat;
  try { stat = await fs.lstat(spoolDirFor(spoolRoot, runId)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory()) return null;

  const run = await companyTransferRunService.getCleanupState(db, runId);
  return { run, mtimeMs: stat.mtimeMs };
}

type Spool = NonNullable<Awaited<ReturnType<typeof readImportTransferSpool>>>;

export function importTransferSpoolDeadline(spool: Spool, maxAgeMs = IMPORT_TRANSFER_SPOOL_MAX_AGE_MS): number | null {
  if (!spool.run) return Math.floor(spool.mtimeMs + maxAgeMs) + 1;
  if (spool.run.status === "completed" || spool.run.status === "cancelled") return 0;
  if (spool.run.status === "pending" || spool.run.status === "running")
    return spool.run.updatedAt.getTime() + maxAgeMs + 1;

  return null;
}




export async function settleImportTransferSpool(
  db: Db, spoolRoot: string, runId: string,
  options: { maxAgeMs?: number; now?: Date } = {},
): Promise<boolean> {
  const spool = await readImportTransferSpool(db, spoolRoot, runId);
  if (!spool) return false;
  const maxAgeMs = options.maxAgeMs ?? IMPORT_TRANSFER_SPOOL_MAX_AGE_MS;
  const now = options.now?.getTime() ?? Date.now();
  const deadline = importTransferSpoolDeadline(spool, maxAgeMs);
  if (deadline === null || deadline > now) return false;
  if (spool.run && spool.run.status !== "completed" && spool.run.status !== "cancelled") {
    const claimed = await companyTransferRunService.cancelIfIdle(db, runId, new Date(now - maxAgeMs),
      "Abandoned import transfer: spooled parts were deleted after prolonged inactivity.");
    if (!claimed) return false;
  }
  await removeImportTransferSpool(spoolRoot, runId);
  return true;
}


export async function sweepAbandonedImportTransferSpools(
  db: Db, spoolRoot: string, options: { maxAgeMs?: number; now?: Date } = {},
): Promise<{ swept: number }> {
  let swept = 0;
  for (const runId of await listImportTransferSpools(spoolRoot)) {
    if (await settleImportTransferSpool(db, spoolRoot, runId, options)) swept++;
  }
  return { swept };
}
