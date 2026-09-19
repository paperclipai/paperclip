/**
 * Orphan run-home sweeper (KEWL-3852).
 *
 * Codex run-homes under codex-run-homes/<runId>/home accumulate when Fix A has
 * not yet deployed or when retention failure leaves a quarantine.  This sweeper
 * identifies "orphan" homes that are safe to remove and deletes them after a
 * conservative grace window.
 *
 * Safety invariants (all must hold for a home to be eligible):
 *   1. The Paperclip heartbeat run is terminal
 *   2. Zero open file handles on the directory tree   (lsof check)
 *   3. mtime of the run-home dir is >=24h ago
 *   4. A best-effort-redacted session counterpart has a valid completion manifest, or a
 *      legacy counterpart contains a non-empty JSONL artifact
 *
 * Invariant 4 ensures we never silently discard a home whose session data was
 * never retained. A sibling <runId>.quarantine marker records retention failure,
 * but does not authorize deletion of the only raw copy.
 *
 * Dry-run mode (default) produces a JSON manifest without deleting anything.
 * Pass --delete to actually remove eligible homes.
 *
 * Usage:
 *   npx tsx packages/adapter-utils/src/acpx-engine/run-home-sweeper.ts \
 *     --company-dir /path/to/companies/<companyId> \
 *     [--delete] [--grace-hours 24]
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface SweeperOptions {
  companyDir: string;
  dryRun: boolean;
  graceHours: number;
  paperclipApiBase?: string;
  paperclipApiKey?: string;
}

interface RunHomeEntry {
  agentId: string;
  runId: string;
  runHomeDir: string;
  ageSecs: number;
  sizeBytes?: number;
  eligible: boolean;
  inspectionFailure?: boolean;
  retentionProof?: "completion_manifest" | "legacy_nonempty_jsonl";
  quarantined?: boolean;
  quarantineMarkerInvalid?: boolean;
  orphanClassification?: "terminal_no_retention_counterpart";
  noCounterpartRecovery?: {
    disposition: "operator_approval_required";
    minimumAgeHours: number;
    ageSatisfied: boolean;
    terminalOwnershipVerified: true;
    zeroOpenHandlesVerified: true;
    rawJsonlCount?: number;
    rawJsonlBytes?: number;
    zeroRawJsonlVerified: boolean;
    reviewCandidate: boolean;
    destructiveRecoveryEnabled: false;
    inspectionError?: string;
  };
  ineligibleReason?: string;
  deleted?: boolean;
  error?: string;
}

interface OrphanQuarantineMarkerEntry {
  agentId: string;
  runId: string;
  markerPath: string;
  ageSecs?: number;
  markerBytes?: number;
  emptyMarker?: boolean;
  quarantineMarkerInvalid?: boolean;
  inspectionFailure?: boolean;
  reason:
    | "run and retained-session counterparts are absent"
    | "quarantine marker path is not a real file"
    | "quarantine marker could not be inspected"
    | "counterpart inspection failed";
  error?: string;
}

const RETENTION_MANIFEST_NAME = "retention-complete.json";
const MINIMUM_GRACE_HOURS = 24;
const MINIMUM_NO_COUNTERPART_RECOVERY_HOURS = 24 * 7;

type RetentionProofCheck =
  | { ok: true; proof: "completion_manifest" | "legacy_nonempty_jsonl" }
  | { ok: false; error: string };

type OpenHandleCheck =
  | { ok: true; hasOpenHandles: boolean }
  | { ok: false; error: string };

type RunStatusCheck =
  | { ok: true; status: string; companyId: string; agentId: string }
  | { ok: false; error: string };

interface SweeperDependencies {
  checkOpenHandles?: (dir: string) => Promise<OpenHandleCheck>;
  getRunStatus?: (
    runId: string,
    apiBase: string,
    apiKey: string,
    expectedCompanyId: string,
    expectedAgentId: string,
  ) => Promise<RunStatusCheck>;
}

function isPathBelow(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function listJsonlArtifacts(
  root: string,
  dir = root,
  relativeDir = "",
): Promise<Map<string, number>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const artifacts = new Map<string, number>();
  for (const entry of entries) {
    const candidate = path.join(dir, entry.name);
    const relativePath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    if (!isPathBelow(root, candidate)) throw new Error("JSONL artifact escaped its configured root");
    if (entry.isSymbolicLink()) throw new Error("JSONL artifact tree contains a symlink");
    if (entry.isDirectory()) {
      const nested = await listJsonlArtifacts(root, candidate, relativePath);
      for (const [nestedPath, size] of nested) artifacts.set(nestedPath, size);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const stat = await fs.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("JSONL artifact is not a real file");
    }
    artifacts.set(relativePath, stat.size);
  }
  return artifacts;
}

async function validateRetentionProof(
  retentionParent: string,
  runId: string,
  runHomeDir: string,
): Promise<RetentionProofCheck> {
  let retentionParentStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    retentionParentStat = await fs.lstat(retentionParent);
  } catch (err) {
    return {
      ok: false,
      error: isErrnoException(err, "ENOENT")
        ? "no retained session counterpart"
        : `retention root could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!retentionParentStat.isDirectory() || retentionParentStat.isSymbolicLink()) {
    return { ok: false, error: "retention root is not a real directory" };
  }
  const retainedDir = path.resolve(retentionParent, runId);
  if (!isPathBelow(retentionParent, retainedDir)) {
    return { ok: false, error: "retained-session path escaped the retention root" };
  }

  let retainedStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    retainedStat = await fs.lstat(retainedDir);
  } catch (err) {
    return {
      ok: false,
      error: isErrnoException(err, "ENOENT")
        ? "no retained session counterpart"
        : `retained-session counterpart could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!retainedStat.isDirectory() || retainedStat.isSymbolicLink()) {
    return { ok: false, error: "retained-session counterpart is not a real directory" };
  }

  const manifestPath = path.join(retainedDir, RETENTION_MANIFEST_NAME);
  let manifestFound = false;
  try {
    const manifestStat = await fs.lstat(manifestPath);
    manifestFound = true;
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      return { ok: false, error: "retention completion manifest is not a real file" };
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      status?: unknown;
      runId?: unknown;
      sessionFileCount?: unknown;
      sessionFiles?: unknown;
    };
    if (
      manifest.schemaVersion !== 1 ||
      manifest.status !== "complete" ||
      manifest.runId !== runId ||
      !Number.isInteger(manifest.sessionFileCount) ||
      (manifest.sessionFileCount as number) < 0 ||
      !Array.isArray(manifest.sessionFiles) ||
      manifest.sessionFiles.length !== manifest.sessionFileCount
    ) {
      return { ok: false, error: "retention completion manifest is invalid" };
    }
    const manifestPaths = new Set<string>();
    for (const relativePath of manifest.sessionFiles) {
      if (
        typeof relativePath !== "string" ||
        relativePath.length === 0 ||
        path.isAbsolute(relativePath) ||
        manifestPaths.has(relativePath)
      ) {
        return { ok: false, error: "retention completion manifest contains an unsafe or duplicate session path" };
      }
      manifestPaths.add(relativePath);
    }

    const rawSessionsDir = path.join(runHomeDir, "sessions");
    let rawArtifacts = new Map<string, number>();
    try {
      const rawSessionsStat = await fs.lstat(rawSessionsDir);
      if (!rawSessionsStat.isDirectory() || rawSessionsStat.isSymbolicLink()) {
        return { ok: false, error: "raw sessions path is not a real directory" };
      }
      rawArtifacts = await listJsonlArtifacts(rawSessionsDir);
    } catch (err) {
      if (!isErrnoException(err, "ENOENT")) {
        return {
          ok: false,
          error: `raw session artifacts could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (
      rawArtifacts.size !== manifestPaths.size ||
      [...rawArtifacts.keys()].some((relativePath) => !manifestPaths.has(relativePath))
    ) {
      return { ok: false, error: "retention completion manifest does not cover the exact raw JSONL set" };
    }

    const sessionsDir = path.join(retainedDir, "sessions");
    const sessionsDirStat = await fs.lstat(sessionsDir);
    if (!sessionsDirStat.isDirectory() || sessionsDirStat.isSymbolicLink()) {
      return { ok: false, error: "retained sessions path is not a real directory" };
    }
    for (const relativePath of manifestPaths) {
      const artifact = path.resolve(sessionsDir, relativePath);
      if (!isPathBelow(sessionsDir, artifact)) {
        return { ok: false, error: "retention completion manifest contains an unsafe session path" };
      }
      const artifactStat = await fs.lstat(artifact);
      if (!artifactStat.isFile() || artifactStat.isSymbolicLink() || artifactStat.size === 0) {
        return { ok: false, error: "retention completion manifest references an invalid session artifact" };
      }
    }
    return { ok: true, proof: "completion_manifest" };
  } catch (err) {
    if (manifestFound || !isErrnoException(err, "ENOENT")) {
      return {
        ok: false,
        error: `retention completion manifest could not be validated: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  try {
    const rawSessionsDir = path.join(runHomeDir, "sessions");
    const rawSessionsStat = await fs.lstat(rawSessionsDir);
    if (!rawSessionsStat.isDirectory() || rawSessionsStat.isSymbolicLink()) {
      return { ok: false, error: "legacy raw sessions path is not a real directory" };
    }
    const rawArtifacts = await listJsonlArtifacts(rawSessionsDir);
    if (rawArtifacts.size === 0) {
      return { ok: false, error: "legacy raw home has no JSONL set that can prove complete retention" };
    }
    const retainedArtifacts = await listJsonlArtifacts(retainedDir);
    const normalizedRetained = new Map<string, number>();
    for (const [relativePath, size] of retainedArtifacts) {
      const normalized = relativePath.startsWith(`sessions${path.sep}`)
        ? relativePath.slice(`sessions${path.sep}`.length)
        : relativePath;
      normalizedRetained.set(normalized, size);
    }
    const complete = [...rawArtifacts].every(([relativePath]) =>
      (normalizedRetained.get(relativePath) ?? 0) > 0
    );
    if (complete) {
      return { ok: true, proof: "legacy_nonempty_jsonl" };
    }
    return {
      ok: false,
      error: "legacy retained-session counterpart does not cover every raw JSONL artifact",
    };
  } catch (err) {
    return {
      ok: false,
      error: `legacy retained-session artifacts could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function inspectRawJsonlSet(runHomeDir: string): Promise<
  { ok: true; count: number; bytes: number } | { ok: false; error: string }
> {
  const sessionsDir = path.join(runHomeDir, "sessions");
  try {
    const stat = await fs.lstat(sessionsDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, error: "raw sessions path is not a real directory" };
    }
    const artifacts = await listJsonlArtifacts(sessionsDir);
    return {
      ok: true,
      count: artifacts.size,
      bytes: [...artifacts.values()].reduce((sum, size) => sum + size, 0),
    };
  } catch (err) {
    if (isErrnoException(err, "ENOENT")) return { ok: true, count: 0, bytes: 0 };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function isErrnoException(err: unknown, code: string): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err && err.code === code;
}

async function checkOpenHandles(dir: string): Promise<OpenHandleCheck> {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/lsof", ["-n", "+D", dir], { timeout: 10_000 });
    return { ok: true, hasOpenHandles: stdout.trim().length > 0 };
  } catch (err) {
    const result = err as { code?: string | number; stdout?: string; stderr?: string };
    // lsof uses exit code 1 with no output when it found no matching handles.
    // Missing binaries, permission errors, timeouts, and diagnostic output are
    // not proof of safety and must block deletion.
    if (result.code === 1 && !(result.stdout ?? "").trim() && !(result.stderr ?? "").trim()) {
      return { ok: true, hasOpenHandles: false };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getRunStatus(
  runId: string,
  apiBase: string,
  apiKey: string,
): Promise<RunStatusCheck> {
  try {
    const normalizedBase = apiBase.replace(/\/+$/, "").replace(/\/api$/, "");
    const url = `${normalizedBase}/api/heartbeat-runs/${encodeURIComponent(runId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return { ok: false, error: `run-status lookup returned HTTP ${res.status}` };
    const body = await res.json() as { status?: string; companyId?: string; agentId?: string };
    if (
      typeof body?.status !== "string" || body.status.length === 0 ||
      typeof body.companyId !== "string" || body.companyId.length === 0 ||
      typeof body.agentId !== "string" || body.agentId.length === 0
    ) {
      return { ok: false, error: "run-status lookup returned incomplete ownership or status data" };
    }
    return { ok: true, status: body.status, companyId: body.companyId, agentId: body.agentId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const TERMINAL_STATUSES = new Set(["succeeded", "interrupted", "cancelled", "failed", "timed_out"]);

async function dirSizeBytes(dir: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("du", ["-sk", dir], { timeout: 30_000 });
    const kb = parseInt(stdout.split("\t")[0] ?? "0", 10);
    return kb * 1024;
  } catch {
    return 0;
  }
}

async function sweepAgentDir(
  agentDir: string,
  agentId: string,
  agentsDir: string,
  opts: SweeperOptions,
  deps: SweeperDependencies,
): Promise<{
  entries: RunHomeEntry[];
  orphanQuarantineMarkerEntries: OrphanQuarantineMarkerEntry[];
}> {
  if (!isPathBelow(agentsDir, agentDir)) {
    return { entries: [], orphanQuarantineMarkerEntries: [] };
  }
  const agentStat = await fs.lstat(agentDir).catch(() => null);
  if (!agentStat?.isDirectory() || agentStat.isSymbolicLink()) {
    return { entries: [], orphanQuarantineMarkerEntries: [] };
  }

  const runHomesParent = path.join(agentDir, "codex-run-homes");
  const runHomesParentStat = await fs.lstat(runHomesParent).catch(() => null);
  if (!runHomesParentStat?.isDirectory() || runHomesParentStat.isSymbolicLink()) {
    return { entries: [], orphanQuarantineMarkerEntries: [] };
  }

  const retentionParent = path.join(agentDir, "codex-session-retention");
  const companyId = path.basename(path.resolve(opts.companyDir));
  const entries: RunHomeEntry[] = [];
  const now = Date.now();
  const graceMs = opts.graceHours * 60 * 60 * 1000;

  let runIds: string[];
  try {
    runIds = await fs.readdir(runHomesParent);
  } catch {
    return { entries: [], orphanQuarantineMarkerEntries: [] };
  }

  const orphanQuarantineMarkerEntries: OrphanQuarantineMarkerEntry[] = [];
  for (const markerName of runIds.filter((name) => name.endsWith(".quarantine"))) {
    const runId = markerName.slice(0, -".quarantine".length);
    if (!runId) continue;
    const markerPath = path.join(runHomesParent, markerName);
    if (!isPathBelow(runHomesParent, markerPath)) continue;

    const inspectCounterpart = async (candidate: string): Promise<
      { exists: boolean } | { exists: false; error: string }
    > => {
      try {
        await fs.lstat(candidate);
        return { exists: true };
      } catch (err) {
        if (isErrnoException(err, "ENOENT")) return { exists: false };
        return { exists: false, error: err instanceof Error ? err.message : String(err) };
      }
    };
    const runCounterpart = await inspectCounterpart(path.join(runHomesParent, runId));
    const retainedCounterpart = await inspectCounterpart(path.join(retentionParent, runId));
    if (runCounterpart.exists || retainedCounterpart.exists) continue;
    const counterpartError =
      ("error" in runCounterpart ? runCounterpart.error : undefined) ??
      ("error" in retainedCounterpart ? retainedCounterpart.error : undefined);

    let markerStat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      markerStat = await fs.lstat(markerPath);
    } catch (err) {
      orphanQuarantineMarkerEntries.push({
        agentId,
        runId,
        markerPath,
        inspectionFailure: true,
        reason: "quarantine marker could not be inspected",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const validMarkerFile = markerStat.isFile() && !markerStat.isSymbolicLink();
    orphanQuarantineMarkerEntries.push({
      agentId,
      runId,
      markerPath,
      ageSecs: (now - markerStat.mtimeMs) / 1000,
      markerBytes: markerStat.size,
      ...(validMarkerFile ? { emptyMarker: markerStat.size === 0 } : {}),
      ...(!validMarkerFile
        ? {
            quarantineMarkerInvalid: true,
            inspectionFailure: true,
            reason: "quarantine marker path is not a real file" as const,
            ...(counterpartError ? { error: counterpartError } : {}),
          }
        : counterpartError
        ? {
            inspectionFailure: true,
            reason: "counterpart inspection failed" as const,
            error: counterpartError,
          }
        : { reason: "run and retained-session counterparts are absent" as const }),
    });
  }

  for (const runId of runIds) {
    const runDir = path.join(runHomesParent, runId);
    const runHomeDir = path.join(runDir, "home");

    if (!isPathBelow(runHomesParent, runDir) || !isPathBelow(runDir, runHomeDir)) continue;
    const runDirStat = await fs.lstat(runDir).catch(() => null);
    if (!runDirStat?.isDirectory() || runDirStat.isSymbolicLink()) continue;

    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(runHomeDir);
    } catch (err) {
      // A missing home can be a live startup window. Report it without mutating
      // even in delete mode; wrapper cleanup is not part of the raw-home gate.
      entries.push({
        agentId,
        runId,
        runHomeDir,
        ageSecs: (now - runDirStat.mtimeMs) / 1000,
        eligible: false,
        ...(isErrnoException(err, "ENOENT")
          ? { ineligibleReason: "raw home absent; wrapper retained" }
          : {
              inspectionFailure: true,
              ineligibleReason: `run home could not be inspected: ${err instanceof Error ? err.message : String(err)}`,
            }),
      });
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      entries.push({
        agentId,
        runId,
        runHomeDir,
        ageSecs: (now - stat.mtimeMs) / 1000,
        eligible: false,
        inspectionFailure: true,
        ineligibleReason: "run home is not a real directory",
      });
      continue;
    }

    const ageSecs = (now - stat.mtimeMs) / 1000;
    const entry: RunHomeEntry = { agentId, runId, runHomeDir, ageSecs, eligible: false };

    // Grace window
    if (stat.mtimeMs > now - graceMs) {
      entry.ineligibleReason = `mtime within ${opts.graceHours}h grace window`;
      entries.push(entry);
      continue;
    }

    if (!opts.paperclipApiBase || !opts.paperclipApiKey) {
      entry.inspectionFailure = true;
      entry.ineligibleReason = "Paperclip API URL and key are required to verify terminal run status";
      entries.push(entry);
      continue;
    }

    const statusCheck = await (deps.getRunStatus ?? getRunStatus)(
      runId,
      opts.paperclipApiBase,
      opts.paperclipApiKey,
      companyId,
      agentId,
    );
    if (!statusCheck.ok) {
      entry.inspectionFailure = true;
      entry.ineligibleReason = `terminal run status could not be verified: ${statusCheck.error}`;
      entries.push(entry);
      continue;
    }
    if (!TERMINAL_STATUSES.has(statusCheck.status)) {
      entry.ineligibleReason = `run status is "${statusCheck.status}" (non-terminal)`;
      entries.push(entry);
      continue;
    }
    if (statusCheck.companyId !== companyId || statusCheck.agentId !== agentId) {
      entry.inspectionFailure = true;
      entry.ineligibleReason = "run ownership does not match the company and agent directory";
      entries.push(entry);
      continue;
    }

    const handleCheck = await (deps.checkOpenHandles ?? checkOpenHandles)(runHomeDir);
    if (!handleCheck.ok) {
      entry.inspectionFailure = true;
      entry.ineligibleReason = `open-handle check failed: ${handleCheck.error}`;
      entries.push(entry);
      continue;
    }
    if (handleCheck.hasOpenHandles) {
      entry.ineligibleReason = "open file handles detected";
      entries.push(entry);
      continue;
    }

    // A sibling FILE is the producer's durable quarantine contract. It vetoes
    // deletion before retained-session or terminal-orphan eligibility is
    // evaluated. A directory/symlink with this name is not the emitted shape;
    // treat it as an invalid marker path and fail closed as well.
    const quarantineMarker = path.join(runHomesParent, `${runId}.quarantine`);
    let quarantineMarkerStat: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      quarantineMarkerStat = await fs.lstat(quarantineMarker);
    } catch (err) {
      if (!isErrnoException(err, "ENOENT")) {
        entry.inspectionFailure = true;
        entry.ineligibleReason = `quarantine marker could not be inspected: ${err instanceof Error ? err.message : String(err)}`;
        entries.push(entry);
        continue;
      }
    }
    const hasQuarantine = quarantineMarkerStat?.isFile() === true && !quarantineMarkerStat.isSymbolicLink();
    entry.quarantined = hasQuarantine;
    entry.quarantineMarkerInvalid = quarantineMarkerStat !== null && !hasQuarantine;
    if (hasQuarantine) {
      entry.ineligibleReason = "run home is quarantined by sibling marker file";
      entries.push(entry);
      continue;
    }
    if (entry.quarantineMarkerInvalid) {
      entry.inspectionFailure = true;
      entry.ineligibleReason = "quarantine marker path is not a real file";
      entries.push(entry);
      continue;
    }

    // A retained session counterpart is mandatory. Unmarked no-counterpart
    // homes are reported for a separate operator-reviewed recovery decision,
    // but remain ineligible in both dry-run and delete modes.
    const retentionProof = await validateRetentionProof(retentionParent, runId, runHomeDir);

    if (!retentionProof.ok) {
      if (retentionProof.error === "no retained session counterpart") {
        const rawJsonl = await inspectRawJsonlSet(runHomeDir);
        const minimumAgeHours = Math.max(
          MINIMUM_NO_COUNTERPART_RECOVERY_HOURS,
          opts.graceHours * 2,
        );
        const ageSatisfied = ageSecs >= minimumAgeHours * 60 * 60;
        const zeroRawJsonlVerified = rawJsonl.ok && rawJsonl.count === 0;
        entry.orphanClassification = "terminal_no_retention_counterpart";
        entry.noCounterpartRecovery = {
          disposition: "operator_approval_required",
          minimumAgeHours,
          ageSatisfied,
          terminalOwnershipVerified: true,
          zeroOpenHandlesVerified: true,
          ...(rawJsonl.ok ? { rawJsonlCount: rawJsonl.count } : {}),
          ...(rawJsonl.ok ? { rawJsonlBytes: rawJsonl.bytes } : {}),
          zeroRawJsonlVerified,
          reviewCandidate: ageSatisfied && zeroRawJsonlVerified,
          destructiveRecoveryEnabled: false,
          ...(!rawJsonl.ok ? { inspectionError: rawJsonl.error } : {}),
        };
        if (!rawJsonl.ok) entry.inspectionFailure = true;
      } else {
        entry.inspectionFailure = true;
      }
      entry.ineligibleReason = retentionProof.error;
      entries.push(entry);
      continue;
    }

    entry.eligible = true;
    entry.retentionProof = retentionProof.proof;
    entry.sizeBytes = await dirSizeBytes(runDir);

    if (!opts.dryRun) {
      try {
        await fs.rm(runDir, { recursive: true, force: true });
        entry.deleted = true;
      } catch (err) {
        entry.deleted = false;
        entry.error = err instanceof Error ? err.message : String(err);
      }
    }

    entries.push(entry);
  }

  return { entries, orphanQuarantineMarkerEntries };
}

export async function sweepRunHomes(opts: SweeperOptions, deps: SweeperDependencies = {}): Promise<{
  scanned: number;
  eligible: number;
  deleted: number;
  errors: number;
  inspectionFailures: number;
  noCounterpartOrphans: number;
  bytesAtRisk: number;
  orphanQuarantineMarkers: number;
  orphanQuarantineMarkerBytes: number;
  totalBytesReclaimed: number;
  entries: RunHomeEntry[];
  orphanQuarantineMarkerEntries: OrphanQuarantineMarkerEntry[];
}> {
  if (!Number.isFinite(opts.graceHours) || opts.graceHours < MINIMUM_GRACE_HOURS) {
    throw new Error(`graceHours must be at least ${MINIMUM_GRACE_HOURS}`);
  }
  const companyDirStat = await fs.lstat(opts.companyDir).catch(() => null);
  if (!companyDirStat?.isDirectory() || companyDirStat.isSymbolicLink()) {
    return {
      scanned: 0,
      eligible: 0,
      deleted: 0,
      errors: 0,
      inspectionFailures: 0,
      noCounterpartOrphans: 0,
      bytesAtRisk: 0,
      orphanQuarantineMarkers: 0,
      orphanQuarantineMarkerBytes: 0,
      totalBytesReclaimed: 0,
      entries: [],
      orphanQuarantineMarkerEntries: [],
    };
  }

  // Validate every configured ancestor before inspecting descendants. lstat on
  // `acp-engine/agents` alone follows a symlinked `acp-engine` component and can
  // make an external tree look lexically contained beneath companyDir.
  const acpEngineDir = path.join(opts.companyDir, "acp-engine");
  const acpEngineDirStat = await fs.lstat(acpEngineDir).catch(() => null);
  if (!acpEngineDirStat?.isDirectory() || acpEngineDirStat.isSymbolicLink()) {
    return {
      scanned: 0,
      eligible: 0,
      deleted: 0,
      errors: 0,
      inspectionFailures: 0,
      noCounterpartOrphans: 0,
      bytesAtRisk: 0,
      orphanQuarantineMarkers: 0,
      orphanQuarantineMarkerBytes: 0,
      totalBytesReclaimed: 0,
      entries: [],
      orphanQuarantineMarkerEntries: [],
    };
  }

  const agentsDir = path.join(acpEngineDir, "agents");
  const agentsDirStat = await fs.lstat(agentsDir).catch(() => null);
  if (!agentsDirStat?.isDirectory() || agentsDirStat.isSymbolicLink()) {
    return {
      scanned: 0,
      eligible: 0,
      deleted: 0,
      errors: 0,
      inspectionFailures: 0,
      noCounterpartOrphans: 0,
      bytesAtRisk: 0,
      orphanQuarantineMarkers: 0,
      orphanQuarantineMarkerBytes: 0,
      totalBytesReclaimed: 0,
      entries: [],
      orphanQuarantineMarkerEntries: [],
    };
  }

  const agentIds = await fs.readdir(agentsDir).catch(() => [] as string[]);
  const allEntries: RunHomeEntry[] = [];
  const allOrphanQuarantineMarkerEntries: OrphanQuarantineMarkerEntry[] = [];

  for (const agentId of agentIds) {
    const agentDir = path.join(agentsDir, agentId);
    const agentResult = await sweepAgentDir(agentDir, agentId, agentsDir, opts, deps);
    allEntries.push(...agentResult.entries);
    allOrphanQuarantineMarkerEntries.push(...agentResult.orphanQuarantineMarkerEntries);
  }

  const eligible = allEntries.filter((e) => e.eligible);
  const deleted = eligible.filter((e) => e.deleted === true);
  const deletionErrors = eligible.filter((e) => e.deleted === false);
  const inspectionFailures = [
    ...allEntries.filter((e) => e.inspectionFailure === true),
    ...allOrphanQuarantineMarkerEntries.filter((entry) => entry.inspectionFailure === true),
  ];
  const noCounterpartOrphans = allEntries.filter(
    (e) => e.orphanClassification === "terminal_no_retention_counterpart",
  );
  const bytesAtRisk = noCounterpartOrphans.reduce(
    (sum, entry) => sum + (entry.noCounterpartRecovery?.rawJsonlBytes ?? 0),
    0,
  );
  const totalBytesReclaimed = deleted.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0);
  const orphanQuarantineMarkerBytes = allOrphanQuarantineMarkerEntries.reduce(
    (sum, entry) => sum + (entry.markerBytes ?? 0),
    0,
  );

  return {
    scanned: allEntries.length,
    eligible: eligible.length,
    deleted: deleted.length,
    errors: deletionErrors.length + inspectionFailures.length,
    inspectionFailures: inspectionFailures.length,
    noCounterpartOrphans: noCounterpartOrphans.length,
    bytesAtRisk,
    orphanQuarantineMarkers: allOrphanQuarantineMarkerEntries.length,
    orphanQuarantineMarkerBytes,
    totalBytesReclaimed,
    entries: allEntries,
    orphanQuarantineMarkerEntries: allOrphanQuarantineMarkerEntries,
  };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const companyDirIndex = args.indexOf("--company-dir");
  const companyDir = companyDirIndex >= 0 && !args[companyDirIndex + 1]?.startsWith("--")
    ? args[companyDirIndex + 1]
    : undefined;
  const dryRun = !args.includes("--delete");
  const graceIdx = args.indexOf("--grace-hours");
  const graceHours = graceIdx >= 0 ? parseInt(args[graceIdx + 1] ?? "24", 10) : 24;

  if (!companyDir) {
    process.stderr.write("Usage: run-home-sweeper.ts --company-dir <path> [--delete] [--grace-hours N]\n");
    process.exit(1);
  }

  sweepRunHomes({
    companyDir,
    dryRun,
    graceHours,
    paperclipApiBase: process.env["PAPERCLIP_API_URL"] ?? process.env["PAPERCLIP_API_BASE"],
    paperclipApiKey: process.env["PAPERCLIP_API_KEY"],
  })
    .then((result) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      const verb = dryRun ? "DRY-RUN" : "DELETED";
      process.stderr.write(
        `[sweeper] ${verb}: scanned=${result.scanned} eligible=${result.eligible} deleted=${result.deleted} errors=${result.errors} inspectionFailures=${result.inspectionFailures} noCounterpartOrphans=${result.noCounterpartOrphans} bytesAtRisk=${result.bytesAtRisk} orphanQuarantineMarkers=${result.orphanQuarantineMarkers} orphanQuarantineMarkerBytes=${result.orphanQuarantineMarkerBytes} reclaimed=${(result.totalBytesReclaimed / 1024 / 1024).toFixed(1)}MB\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`[sweeper] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
