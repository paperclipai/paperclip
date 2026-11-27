import type { VerifiedIdleCapabilities } from "./idle-incoming-wake-capability.js";
import { idleApiActivity } from "./idle-api-activity.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { idleWorkSnapshot } from "./task-admission.js";
import type { IdleSleepDiagnosticSink } from "./idle-sleep-diagnostics.js";

export type IdleLocalWorkOptions = { backupCheckpoint?: boolean; diagnostic?: IdleSleepDiagnosticSink; deadlineCapability?: VerifiedIdleCapabilities };
export type IdleLocalWork = "none" | "present" | "unknown";
const spoolDirectories = new Set<string>();
const localWorkProbes = new Set<(options: IdleLocalWorkOptions) => IdleLocalWork>();
export function registerIdleLocalWorkProbe(probe: (options: IdleLocalWorkOptions) => IdleLocalWork): () => void {
  localWorkProbes.add(probe);
  return () => { localWorkProbes.delete(probe); };
}
export function registerIdleSpoolDirectory(directory: string): void { spoolDirectories.add(path.resolve(directory)); }
export const idleAccountingSpoolPath = () => path.join(resolvePaperclipInstanceRoot(), "accounting-receipts");
export const idleOrphanSpoolPath = () => process.env.SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR ??
  path.join(resolvePaperclipInstanceRoot(), "data", "sandbox-orphan-cleanup");
export const idleQuotaRecoveryPath = () => path.join(resolvePaperclipInstanceRoot(), "quota-credential-recovery");
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

/** Credential journals are grouped by company. Successful recovery leaves its
 * empty company directory behind; every file, probe or unexpected entry still
 * blocks. Never decrypt journals or follow directory symlinks during a scan. */
export async function inspectIdleQuotaRecovery(directory: string): Promise<IdleLocalWork> {
  try {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) return "unknown";
    const dir = await fs.opendir(directory);
    try {
      for (let entry = await dir.read(); entry !== null; entry = await dir.read()) {
        if (!entry.isDirectory() || entry.isSymbolicLink()
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.name)) return "present";
        const state = await inspectIdleSpool(path.join(directory, entry.name));
        if (state !== "none") return state;
      }
      return "none";
    } finally { await dir.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "none" : "unknown";
  }
}

export async function readIdleLocalWork(options: IdleLocalWorkOptions = {}): Promise<IdleLocalWork> {
  const record = options.diagnostic;
  const states: IdleLocalWork[] = [];
  record?.("local.startup", startupComplete ? "none" : "unknown");
  record?.("local.ingress_tracking", ingressTracked ? "none" : "unknown");
  if (!startupComplete || !ingressTracked) {
    if (!record) return "unknown";
    states.push("unknown");
  }
  // This exemption belongs only to a scan which will finish a new backup
  // under the same admission hold before it can return an empty report.
  const backup = scheduledBackups && !options.backupCheckpoint;
  const active = idleWorkSnapshot().active !== 0;
  record?.("local.automatic_backups", backup ? "present" : "none");
  record?.("local.tracked_work", active ? "present" : "none");
  if (backup || active) {
    if (!record) return "present";
    states.push("present");
  }
  let probes: IdleLocalWork;
  try {
    const local = [idleApiActivity.active() ? "present" : "none", ...[...localWorkProbes].map(probe => probe(options))];
    probes = local.some(state => state !== "none" && state !== "present") ? "unknown"
      : local.includes("present") ? "present" : "none";
  } catch { probes = "unknown"; }
  record?.("local.registered_probes", probes);
  if (probes !== "none" && !record) return probes;
  states.push(probes);
  const accounting = idleAccountingSpoolPath();
  const orphan = idleOrphanSpoolPath();
  const directories = new Set([...spoolDirectories, accounting, orphan]);
  const results = await Promise.all([
    ...[...directories].map(async directory => {
      const state = await inspectIdleSpool(directory);
      record?.(directory === accounting ? "local.accounting_spool"
        : directory === orphan ? "local.orphan_spool" : "local.registered_spools", state);
      return state;
    }),
    inspectIdleQuotaRecovery(idleQuotaRecoveryPath()).then(state => {
      record?.("local.quota_recovery", state);
      return state;
    }),
  ]);
  states.push(...results);
  if (states.includes("unknown")) return "unknown";
  return states.includes("present") ? "present" : "none";
}
