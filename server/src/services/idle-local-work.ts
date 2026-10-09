import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { idleWorkSnapshot } from "./task-admission.js";

export type IdleLocalWork = "none" | "present" | "unknown";
const spoolDirectories = new Set<string>();
export function registerIdleSpoolDirectory(directory: string): void { spoolDirectories.add(path.resolve(directory)); }
export const idleAccountingSpoolPath = () => path.join(resolvePaperclipInstanceRoot(), "accounting-receipts");
export const idleOrphanSpoolPath = () => process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR ??
  path.join(resolvePaperclipInstanceRoot(), "data", "sandbox-orphan-cleanup");
let startupComplete = false;
let ingressTracked = false;
let scheduledBackups = false;
export function markIdleIngressTracked() { ingressTracked = true; }
export function markIdleStartupComplete(options: { scheduledBackups: boolean }) {
  scheduledBackups = options.scheduledBackups;
  startupComplete = true;
}

/** Any entry, including malformed JSON, a temp file or a failed probe, is
 * evidence to retain. Recovery readers intentionally skip some such files;
 * they cannot certify that stopping the process is safe. */
export async function inspectIdleSpool(directory: string): Promise<IdleLocalWork> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return "unknown";
    const dir = await fs.opendir(directory);
    try { return (await dir.read()) === null ? "none" : "present"; }
    finally { await dir.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unknown";
  }
}

export async function readIdleLocalWork(options: { backupCheckpoint?: boolean } = {}): Promise<IdleLocalWork> {
  if (!startupComplete || !ingressTracked) return "unknown";
  // This exemption belongs only to a scan which will finish a new backup
  // under the same admission hold before it can return an empty report.
  if ((scheduledBackups && !options.backupCheckpoint) || idleWorkSnapshot().active !== 0) return "present";
  const directories = new Set([...spoolDirectories, idleAccountingSpoolPath(), idleOrphanSpoolPath()]);
  const results = await Promise.all([...directories].map(inspectIdleSpool));
  if (results.includes("unknown")) return "unknown";
  return results.includes("present") ? "present" : "none";
}
