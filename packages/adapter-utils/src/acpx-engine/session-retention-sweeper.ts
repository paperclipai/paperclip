/**
 * Bounded lifecycle for best-effort-redacted Codex session retention.
 *
 * The default policy retains at most 30 days, 1,000 run directories, and 1 GiB
 * per agent. This tool is dry-run by default. Destructive cleanup requires both
 * `--delete` and `--operator-approved`; nothing schedules it automatically.
 * A retained counterpart is never removed while its raw run directory still
 * exists, because the run-home sweeper may still need that exact proof.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

export const DEFAULT_CODEX_RETENTION_DAYS = 30;
export const DEFAULT_CODEX_RETENTION_MAX_RUNS = 1_000;
export const DEFAULT_CODEX_RETENTION_MAX_BYTES = 1024 * 1024 * 1024;

export interface SessionRetentionSweepOptions {
  companyDir: string;
  dryRun: boolean;
  operatorApproved?: boolean;
  retentionDays?: number;
  maxRunsPerAgent?: number;
  maxBytesPerAgent?: number;
  nowMs?: number;
}

export interface SessionRetentionEntry {
  agentId: string;
  runId: string;
  retainedRunDir: string;
  ageSecs: number;
  sizeBytes?: number;
  expiredByTtl: boolean;
  expiredByCountCap: boolean;
  expiredByByteCap: boolean;
  eligible: boolean;
  inspectionFailure?: boolean;
  rawRunHomePresent: boolean;
  quarantineMarkerPresent: boolean;
  quarantineMarkerInvalid?: boolean;
  wouldDeleteQuarantineMarker: boolean;
  ineligibleReason?: string;
  deleted?: boolean;
  quarantineMarkerDeleted?: boolean;
  quarantineMarkerCleanupError?: string;
  error?: string;
}

function isPathBelow(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === code;
}

async function inspectTree(root: string, dir = root): Promise<number> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    const candidate = path.join(dir, entry.name);
    if (!isPathBelow(root, candidate)) throw new Error("retention artifact escaped its configured root");
    if (entry.isSymbolicLink()) throw new Error("retention artifact tree contains a symlink");
    if (entry.isDirectory()) {
      bytes += await inspectTree(root, candidate);
      continue;
    }
    if (!entry.isFile()) throw new Error("retention artifact is not a regular file");
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("retention artifact is not a real file");
    bytes += stat.size;
  }
  return bytes;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be greater than zero`);
  return value;
}

export async function sweepCodexSessionRetention(options: SessionRetentionSweepOptions): Promise<{
  policy: { retentionDays: number; maxRunsPerAgent: number; maxBytesPerAgent: number };
  scanned: number;
  eligible: number;
  deleted: number;
  errors: number;
  inspectionFailures: number;
  bytesEligible: number;
  bytesDeleted: number;
  runsStillOverCap: number;
  bytesStillOverCap: number;
  entries: SessionRetentionEntry[];
}> {
  if (!options.dryRun && options.operatorApproved !== true) {
    throw new Error("destructive retention cleanup requires explicit operator approval");
  }
  const retentionDays = positiveFinite(options.retentionDays ?? DEFAULT_CODEX_RETENTION_DAYS, "retentionDays");
  const maxRunsPerAgent = positiveFinite(
    options.maxRunsPerAgent ?? DEFAULT_CODEX_RETENTION_MAX_RUNS,
    "maxRunsPerAgent",
  );
  const maxBytesPerAgent = positiveFinite(
    options.maxBytesPerAgent ?? DEFAULT_CODEX_RETENTION_MAX_BYTES,
    "maxBytesPerAgent",
  );
  const policy = { retentionDays, maxRunsPerAgent, maxBytesPerAgent };
  const now = options.nowMs ?? Date.now();
  const entries: SessionRetentionEntry[] = [];

  const companyStat = await fs.lstat(options.companyDir).catch(() => null);
  const engineDir = path.join(options.companyDir, "acp-engine");
  const engineStat = await fs.lstat(engineDir).catch(() => null);
  const agentsDir = path.join(engineDir, "agents");
  const agentsStat = await fs.lstat(agentsDir).catch(() => null);
  if (
    !companyStat?.isDirectory() || companyStat.isSymbolicLink() ||
    !engineStat?.isDirectory() || engineStat.isSymbolicLink() ||
    !agentsStat?.isDirectory() || agentsStat.isSymbolicLink()
  ) {
    return {
      policy,
      scanned: 0,
      eligible: 0,
      deleted: 0,
      errors: 0,
      inspectionFailures: 0,
      bytesEligible: 0,
      bytesDeleted: 0,
      runsStillOverCap: 0,
      bytesStillOverCap: 0,
      entries,
    };
  }

  let runsStillOverCap = 0;
  let bytesStillOverCap = 0;
  for (const agentId of await fs.readdir(agentsDir).catch(() => [] as string[])) {
    const agentDir = path.join(agentsDir, agentId);
    if (!isPathBelow(agentsDir, agentDir)) continue;
    const agentStat = await fs.lstat(agentDir).catch(() => null);
    if (!agentStat?.isDirectory() || agentStat.isSymbolicLink()) continue;
    const retentionRoot = path.join(agentDir, "codex-session-retention");
    const retentionRootStat = await fs.lstat(retentionRoot).catch(() => null);
    if (!retentionRootStat?.isDirectory() || retentionRootStat.isSymbolicLink()) continue;
    const runHomesRoot = path.join(agentDir, "codex-run-homes");
    const runHomesRootStat = await fs.lstat(runHomesRoot).catch(() => null);
    const runHomesRootUnsafe = runHomesRootStat !== null &&
      (!runHomesRootStat.isDirectory() || runHomesRootStat.isSymbolicLink());

    const candidates: Array<SessionRetentionEntry & { retainedAtMs: number }> = [];
    for (const runId of await fs.readdir(retentionRoot).catch(() => [] as string[])) {
      const retainedRunDir = path.join(retentionRoot, runId);
      if (!isPathBelow(retentionRoot, retainedRunDir)) continue;
      const stat = await fs.lstat(retainedRunDir).catch(() => null);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) {
        candidates.push({
          agentId,
          runId,
          retainedRunDir,
          retainedAtMs: stat?.mtimeMs ?? now,
          ageSecs: stat ? (now - stat.mtimeMs) / 1000 : 0,
          expiredByTtl: false,
          expiredByCountCap: false,
          expiredByByteCap: false,
          eligible: false,
          inspectionFailure: true,
          rawRunHomePresent: false,
          quarantineMarkerPresent: false,
          wouldDeleteQuarantineMarker: false,
          ineligibleReason: "retained run path is not a real directory",
        });
        continue;
      }
      let sizeBytes: number;
      try {
        sizeBytes = await inspectTree(retainedRunDir);
      } catch (err) {
        candidates.push({
          agentId,
          runId,
          retainedRunDir,
          retainedAtMs: stat.mtimeMs,
          ageSecs: (now - stat.mtimeMs) / 1000,
          expiredByTtl: false,
          expiredByCountCap: false,
          expiredByByteCap: false,
          eligible: false,
          inspectionFailure: true,
          rawRunHomePresent: false,
          quarantineMarkerPresent: false,
          wouldDeleteQuarantineMarker: false,
          ineligibleReason: `retention tree could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      const rawRunHome = path.join(runHomesRoot, runId, "home");
      const marker = path.join(runHomesRoot, `${runId}.quarantine`);
      let pathInspectionError: string | undefined;
      let rawRunHomePresent = false;
      let markerStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
      if (!runHomesRootUnsafe) {
        try {
          await fs.lstat(rawRunHome);
          rawRunHomePresent = true;
        } catch (err) {
          if (!isErrnoException(err, "ENOENT")) {
            pathInspectionError = `raw run home could not be inspected: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        try {
          markerStat = await fs.lstat(marker);
        } catch (err) {
          if (!isErrnoException(err, "ENOENT")) {
            pathInspectionError ??=
              `quarantine marker could not be inspected: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      }
      const quarantineMarkerPresent = markerStat?.isFile() === true && !markerStat.isSymbolicLink();
      const quarantineMarkerInvalid = markerStat !== null && !quarantineMarkerPresent;
      candidates.push({
        agentId,
        runId,
        retainedRunDir,
        retainedAtMs: stat.mtimeMs,
        ageSecs: (now - stat.mtimeMs) / 1000,
        sizeBytes,
        expiredByTtl: stat.mtimeMs <= now - retentionDays * 24 * 60 * 60 * 1000,
        expiredByCountCap: false,
        expiredByByteCap: false,
        eligible: false,
        inspectionFailure: runHomesRootUnsafe || quarantineMarkerInvalid || pathInspectionError !== undefined,
        rawRunHomePresent,
        quarantineMarkerPresent,
        quarantineMarkerInvalid,
        wouldDeleteQuarantineMarker: quarantineMarkerPresent && !rawRunHomePresent,
        ...(pathInspectionError
          ? { ineligibleReason: pathInspectionError }
          : runHomesRootUnsafe
          ? { ineligibleReason: "Codex run-home root is not a real directory" }
          : quarantineMarkerInvalid
            ? { ineligibleReason: "quarantine marker path is not a real file" }
            : {}),
      });
    }

    const oldestFirst = [...candidates]
      .sort((a, b) => a.retainedAtMs - b.retainedAtMs || a.runId.localeCompare(b.runId));
    const inspectable = oldestFirst
      .filter((entry) => entry.sizeBytes !== undefined);
    const canRemoveForCap = (entry: SessionRetentionEntry): boolean =>
      entry.ineligibleReason === undefined && !entry.rawRunHomePresent;
    let projectedCount = candidates.length;
    for (const entry of oldestFirst) {
      if (projectedCount <= Math.floor(maxRunsPerAgent)) break;
      entry.expiredByCountCap = true;
      // Protected or uninspectable entries still count against the cap. Keep
      // walking so the dry run proposes enough removable entries to restore
      // the bound as far as the fail-closed exclusions allow.
      if (canRemoveForCap(entry)) projectedCount -= 1;
    }
    let projectedBytes = inspectable.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0);
    for (const entry of inspectable) {
      if (projectedBytes <= maxBytesPerAgent) break;
      entry.expiredByByteCap = true;
      if (canRemoveForCap(entry)) projectedBytes -= entry.sizeBytes ?? 0;
    }

    for (const entry of candidates) {
      const expired = entry.expiredByTtl || entry.expiredByCountCap || entry.expiredByByteCap;
      if (entry.ineligibleReason) {
        entries.push(entry);
        continue;
      }
      if (!expired) {
        entry.ineligibleReason = "within retention TTL and agent caps";
      } else if (entry.rawRunHomePresent) {
        entry.ineligibleReason = "raw run home still exists; retained proof must be preserved";
      } else {
        entry.eligible = true;
      }

      if (entry.eligible && !options.dryRun) {
        try {
          await fs.rm(entry.retainedRunDir, { recursive: true, force: true });
          entry.deleted = true;
          if (entry.quarantineMarkerPresent) {
            try {
              await fs.rm(path.join(runHomesRoot, `${entry.runId}.quarantine`), { force: true });
              entry.quarantineMarkerDeleted = true;
            } catch (markerErr) {
              entry.quarantineMarkerDeleted = false;
              entry.quarantineMarkerCleanupError = markerErr instanceof Error
                ? markerErr.message
                : String(markerErr);
            }
          }
        } catch (err) {
          entry.deleted = false;
          entry.error = err instanceof Error ? err.message : String(err);
        }
      }
      entries.push(entry);
    }

    const retainedAfterProposedCleanup = candidates.filter(
      (entry) => !(entry.eligible && (options.dryRun || entry.deleted === true)),
    );
    runsStillOverCap += Math.max(0, retainedAfterProposedCleanup.length - Math.floor(maxRunsPerAgent));
    const retainedBytesAfterProposedCleanup = retainedAfterProposedCleanup.reduce(
      (sum, entry) => sum + (entry.sizeBytes ?? 0),
      0,
    );
    bytesStillOverCap += Math.max(0, retainedBytesAfterProposedCleanup - maxBytesPerAgent);
  }

  const eligible = entries.filter((entry) => entry.eligible);
  const deleted = eligible.filter((entry) => entry.deleted === true);
  const inspectionFailures = entries.filter((entry) => entry.inspectionFailure === true);
  const deletionErrors = eligible.filter((entry) => entry.deleted === false);
  return {
    policy,
    scanned: entries.length,
    eligible: eligible.length,
    deleted: deleted.length,
    errors: deletionErrors.length + inspectionFailures.length + eligible.filter(
      (entry) => entry.quarantineMarkerCleanupError !== undefined,
    ).length,
    inspectionFailures: inspectionFailures.length,
    bytesEligible: eligible.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    bytesDeleted: deleted.reduce((sum, entry) => sum + (entry.sizeBytes ?? 0), 0),
    runsStillOverCap,
    bytesStillOverCap,
    entries,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const companyDirIndex = args.indexOf("--company-dir");
  const companyDir = companyDirIndex >= 0 && !args[companyDirIndex + 1]?.startsWith("--")
    ? args[companyDirIndex + 1]
    : undefined;
  const dryRun = !args.includes("--delete");
  const numberArg = (name: string, fallback: number): number => {
    const index = args.indexOf(name);
    return index >= 0 ? Number(args[index + 1]) : fallback;
  };
  if (!companyDir) {
    process.stderr.write(
      "Usage: session-retention-sweeper.ts --company-dir <path> [--retention-days N] [--max-runs N] [--max-bytes N] [--delete --operator-approved]\n",
    );
    process.exit(1);
  }
  sweepCodexSessionRetention({
    companyDir,
    dryRun,
    operatorApproved: args.includes("--operator-approved"),
    retentionDays: numberArg("--retention-days", DEFAULT_CODEX_RETENTION_DAYS),
    maxRunsPerAgent: numberArg("--max-runs", DEFAULT_CODEX_RETENTION_MAX_RUNS),
    maxBytesPerAgent: numberArg("--max-bytes", DEFAULT_CODEX_RETENTION_MAX_BYTES),
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((err) => {
    process.stderr.write(`[retention-sweeper] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
