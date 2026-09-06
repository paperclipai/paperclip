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
 *   4. A sanitized session counterpart exists under codex-session-retention/<runId>/
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
  ineligibleReason?: string;
  deleted?: boolean;
  error?: string;
}

type OpenHandleCheck =
  | { ok: true; hasOpenHandles: boolean }
  | { ok: false; error: string };

type RunStatusCheck =
  | { ok: true; status: string }
  | { ok: false; error: string };

interface SweeperDependencies {
  checkOpenHandles?: (dir: string) => Promise<OpenHandleCheck>;
  getRunStatus?: (runId: string, apiBase: string, apiKey: string) => Promise<RunStatusCheck>;
}

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
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
    const body = await res.json() as { status?: string };
    if (typeof body?.status !== "string" || body.status.length === 0) {
      return { ok: false, error: "run-status lookup returned no status" };
    }
    return { ok: true, status: body.status };
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
  opts: SweeperOptions,
  deps: SweeperDependencies,
): Promise<RunHomeEntry[]> {
  const runHomesParent = path.join(agentDir, "codex-run-homes");
  if (!(await pathExists(runHomesParent))) return [];

  const retentionParent = path.join(agentDir, "codex-session-retention");
  const entries: RunHomeEntry[] = [];
  const now = Date.now();
  const graceMs = opts.graceHours * 60 * 60 * 1000;

  let runIds: string[];
  try {
    runIds = await fs.readdir(runHomesParent);
  } catch {
    return [];
  }

  for (const runId of runIds) {
    const runDir = path.join(runHomesParent, runId);
    const runHomeDir = path.join(runDir, "home");

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(runHomeDir);
    } catch {
      // The raw home is already gone. Remove the wrapper only when it is empty.
      await fs.rmdir(runDir).catch(() => {});
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
      entry.ineligibleReason = "Paperclip API URL and key are required to verify terminal run status";
      entries.push(entry);
      continue;
    }

    const statusCheck = await (deps.getRunStatus ?? getRunStatus)(
      runId,
      opts.paperclipApiBase,
      opts.paperclipApiKey,
    );
    if (!statusCheck.ok) {
      entry.ineligibleReason = `terminal run status could not be verified: ${statusCheck.error}`;
      entries.push(entry);
      continue;
    }
    if (!TERMINAL_STATUSES.has(statusCheck.status)) {
      entry.ineligibleReason = `run status is "${statusCheck.status}" (non-terminal)`;
      entries.push(entry);
      continue;
    }

    const handleCheck = await (deps.checkOpenHandles ?? checkOpenHandles)(runHomeDir);
    if (!handleCheck.ok) {
      entry.ineligibleReason = `open-handle check failed: ${handleCheck.error}`;
      entries.push(entry);
      continue;
    }
    if (handleCheck.hasOpenHandles) {
      entry.ineligibleReason = "open file handles detected";
      entries.push(entry);
      continue;
    }

    // A retained session counterpart is mandatory. Quarantine is evidence that
    // retention failed, so it must never substitute for a sanitized copy.
    const retainedDir = path.join(retentionParent, runId);
    const quarantineMarker = path.join(runHomesParent, `${runId}.quarantine`);
    const hasRetained = await pathExists(retainedDir);
    const hasQuarantine = await pathExists(quarantineMarker);

    if (!hasRetained) {
      entry.ineligibleReason = hasQuarantine
        ? "run home is quarantined and has no retained session counterpart"
        : "no retained session counterpart";
      entries.push(entry);
      continue;
    }

    entry.eligible = true;
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

  return entries;
}

export async function sweepRunHomes(opts: SweeperOptions, deps: SweeperDependencies = {}): Promise<{
  scanned: number;
  eligible: number;
  deleted: number;
  errors: number;
  totalBytesReclaimed: number;
  entries: RunHomeEntry[];
}> {
  const agentsDir = path.join(opts.companyDir, "acp-engine", "agents");
  if (!(await pathExists(agentsDir))) {
    return { scanned: 0, eligible: 0, deleted: 0, errors: 0, totalBytesReclaimed: 0, entries: [] };
  }

  const agentIds = await fs.readdir(agentsDir).catch(() => [] as string[]);
  const allEntries: RunHomeEntry[] = [];

  for (const agentId of agentIds) {
    const agentDir = path.join(agentsDir, agentId);
    const agentEntries = await sweepAgentDir(agentDir, agentId, opts, deps);
    allEntries.push(...agentEntries);
  }

  const eligible = allEntries.filter((e) => e.eligible);
  const deleted = eligible.filter((e) => e.deleted === true);
  const errors = eligible.filter((e) => e.deleted === false);
  const totalBytesReclaimed = deleted.reduce((sum, e) => sum + (e.sizeBytes ?? 0), 0);

  return {
    scanned: allEntries.length,
    eligible: eligible.length,
    deleted: deleted.length,
    errors: errors.length,
    totalBytesReclaimed,
    entries: allEntries,
  };
}

// CLI entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const companyDir = args[args.indexOf("--company-dir") + 1];
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
        `[sweeper] ${verb}: scanned=${result.scanned} eligible=${result.eligible} deleted=${result.deleted} errors=${result.errors} reclaimed=${(result.totalBytesReclaimed / 1024 / 1024).toFixed(1)}MB\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`[sweeper] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
