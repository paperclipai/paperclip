import fs from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../config/home.js";
import type { CheckResult } from "./index.js";

/**
 * Paperclip silently accumulates a lot on local disk — embedded Postgres WAL,
 * run-log NDJSON, prompt-cache snapshots — and on the production analysis
 * that motivated this check, a `No space left on device` from inside the
 * embedded Postgres surfaced only as repeated INSERT failures in the server
 * log. This check surfaces both the host filesystem health and Paperclip's
 * own footprint before that point.
 */

export const DISK_FREE_FAIL_PERCENT = 5; // <5% free → fail
export const DISK_FREE_WARN_PERCENT = 15; // <15% free → warn
export const FOOTPRINT_WARN_BYTES = 5 * 1024 ** 3; // 5 GiB

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  percentUsed: number;
  percentFree: number;
}

export interface DiskFootprintEntry {
  name: string;
  path: string;
  bytes: number;
}

export interface DiskFootprint {
  rootPath: string;
  totalBytes: number;
  entries: DiskFootprintEntry[];
}

/** Footprint subpaths under an instance root, in display order. */
const FOOTPRINT_SUBPATHS: readonly string[] = [
  "db",
  "data",
  "logs",
  "companies",
  "workspaces",
  "projects",
] as const;

export function readDiskUsage(targetPath: string): DiskUsage | null {
  const probe = locateExistingAncestor(targetPath);
  if (!probe) return null;
  let stats: ReturnType<typeof fs.statfsSync>;
  try {
    stats = fs.statfsSync(probe);
  } catch {
    return null;
  }
  const blockSize = Number(stats.bsize);
  const totalBytes = Number(stats.blocks) * blockSize;
  const freeBytes = Number(stats.bavail) * blockSize;
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const percentUsed = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  const percentFree = Math.max(0, 100 - percentUsed);
  return { totalBytes, freeBytes, usedBytes, percentUsed, percentFree };
}

export function readDirectorySizeBytes(dirPath: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += readDirectorySizeBytes(child);
      } else if (entry.isFile()) {
        const stat = fs.statSync(child);
        total += stat.size;
      }
    } catch {
      // best-effort; permission errors or in-flight deletions are skipped
    }
  }
  return total;
}

export function computeFootprint(instanceRoot: string): DiskFootprint {
  const entries: DiskFootprintEntry[] = [];
  for (const name of FOOTPRINT_SUBPATHS) {
    const subPath = path.join(instanceRoot, name);
    if (!fs.existsSync(subPath)) continue;
    entries.push({ name, path: subPath, bytes: readDirectorySizeBytes(subPath) });
  }
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  entries.sort((a, b) => b.bytes - a.bytes);
  return { rootPath: instanceRoot, totalBytes, entries };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"] as const;
  let idx = 0;
  let value = bytes;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  const precision = value >= 100 || idx === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[idx]}`;
}

export interface DiskCheckEvaluation {
  status: CheckResult["status"];
  diskMessage: string;
  footprintMessage: string;
  repairHint?: string;
}

export function evaluateDiskHealth(
  disk: DiskUsage | null,
  footprint: DiskFootprint,
): DiskCheckEvaluation {
  const footprintMessage = formatFootprintMessage(footprint);

  if (!disk) {
    return {
      status: "warn",
      diskMessage: "Could not read filesystem statistics for the data directory.",
      footprintMessage,
      repairHint:
        "Make sure the Paperclip data directory exists and is readable, then re-run doctor.",
    };
  }

  const usedPct = disk.percentUsed.toFixed(0);
  const freePct = disk.percentFree.toFixed(0);
  const diskMessage = `Filesystem ${usedPct}% used (free ${formatBytes(disk.freeBytes)} of ${formatBytes(disk.totalBytes)}).`;

  if (disk.percentFree < DISK_FREE_FAIL_PERCENT) {
    return {
      status: "fail",
      diskMessage: `${diskMessage} Less than ${DISK_FREE_FAIL_PERCENT}% free on the data filesystem.`,
      footprintMessage,
      repairHint:
        "Free space immediately — embedded Postgres will fail INSERT/UPDATE silently when the disk is full.",
    };
  }

  if (
    disk.percentFree < DISK_FREE_WARN_PERCENT ||
    footprint.totalBytes > FOOTPRINT_WARN_BYTES
  ) {
    return {
      status: "warn",
      diskMessage: `${diskMessage} Free space is below ${DISK_FREE_WARN_PERCENT}%${
        footprint.totalBytes > FOOTPRINT_WARN_BYTES
          ? ` and Paperclip's footprint exceeds ${formatBytes(FOOTPRINT_WARN_BYTES)}`
          : ""
      }.`,
      footprintMessage,
      repairHint:
        "Consider archiving old run-logs, taking a db backup with `paperclipai db:backup`, or pointing --data-dir at a larger volume.",
    };
  }

  return {
    status: "pass",
    diskMessage,
    footprintMessage,
  };
}

function formatFootprintMessage(footprint: DiskFootprint): string {
  if (footprint.entries.length === 0) {
    return `No Paperclip data found under ${footprint.rootPath} yet.`;
  }
  const breakdown = footprint.entries
    .slice(0, 4)
    .map((entry) => `${entry.name} ${formatBytes(entry.bytes)}`)
    .join(", ");
  return `Paperclip footprint ${formatBytes(footprint.totalBytes)} (${breakdown}) at ${footprint.rootPath}.`;
}

function locateExistingAncestor(targetPath: string): string | null {
  let current = path.resolve(targetPath);
  while (true) {
    if (fs.existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function diskCheck(instanceId?: string): CheckResult {
  const instanceRoot = resolvePaperclipInstanceRoot(instanceId);
  const disk = readDiskUsage(instanceRoot);
  const footprint = computeFootprint(instanceRoot);
  const evaluation = evaluateDiskHealth(disk, footprint);

  return {
    name: "Disk",
    status: evaluation.status,
    message: `${evaluation.diskMessage} ${evaluation.footprintMessage}`.trim(),
    canRepair: false,
    repairHint: evaluation.repairHint,
  };
}
