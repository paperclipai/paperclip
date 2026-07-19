import path from "node:path";
import { runSshCommand, shellQuote, type SshRemoteExecutionSpec } from "./ssh.js";

// Per-run execution workspaces live under `<baseCwd>/.paperclip-runtime/runs/<runId>/workspace`.
// They are throwaway by design — `restoreWorkspace()` merges changes back to the canonical
// workspace before a run ends — so nothing should keep them around. Historically nothing
// deleted them, so crashed / timed-out runs (whose restore never ran) leaked their copies and
// grew `.paperclip-runtime/runs` without bound until the host hit `ENOSPC`.
//
// This module owns the retention policy: a pure selection function (unit-tested), env-driven
// config, and thin SSH helpers to list/remove the remote run directories.

export const RUNTIME_RUNS_DIR_SEGMENTS = [".paperclip-runtime", "runs"] as const;

export const DEFAULT_RUN_WORKSPACE_RETENTION_HOURS = 24;

export interface RunWorkspaceEntry {
  /** The `<runId>` directory name directly under `.paperclip-runtime/runs`. */
  runId: string;
  /** Last-modification time of the run directory, in epoch milliseconds. */
  mtimeMs: number;
}

export interface RunWorkspaceGcConfig {
  /** When true, a completed run keeps its workspace copy (debugging opt-out). */
  keepOnCompletion: boolean;
  /** When false, the opportunistic/periodic sweep is disabled entirely. */
  sweepEnabled: boolean;
  /** Terminal run dirs older than this many ms are swept. `<= 0` disables the TTL rule. */
  retentionMs: number;
  /** Keep at most this many most-recent terminal run dirs; `null` disables the count cap. */
  maxCount: number | null;
}

export interface SelectRunWorkspacesForGcInput {
  entries: RunWorkspaceEntry[];
  /** Run ids with a live process — never deleted regardless of age. */
  activeRunIds?: Iterable<string>;
  /** Terminal run dirs older than this many ms are eligible. `<= 0` disables the TTL rule. */
  retentionMs: number;
  /** Current wall-clock time, epoch ms. */
  now: number;
  /** Keep at most this many most-recent terminal run dirs; `null`/`undefined` disables. */
  maxCount?: number | null;
}

export interface RunWorkspaceGcSelection {
  deleteRunIds: string[];
  keepRunIds: string[];
}

/**
 * Decide which per-run workspace directories to reclaim.
 *
 * A directory is deleted when it is **not** backed by a live process AND it is either older than
 * the retention TTL, or beyond the most-recent `maxCount` terminal dirs. A run with a live process
 * is always spared — we rely on the process-registry signal rather than mtime alone, because a
 * manual purge (e.g. `touch`) can bump mtimes and make a live run look old.
 */
export function selectRunWorkspacesForGc(input: SelectRunWorkspacesForGcInput): RunWorkspaceGcSelection {
  const active = new Set<string>();
  for (const id of input.activeRunIds ?? []) active.add(id);
  const maxCount = input.maxCount ?? null;

  // Never touch a run with a live process. Order the rest newest-first so the count cap keeps
  // the freshest dirs.
  const candidates = input.entries
    .filter((entry) => !active.has(entry.runId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const deleteRunIds: string[] = [];
  const keepRunIds: string[] = [];

  // Live runs that actually have a directory are always kept.
  for (const entry of input.entries) {
    if (active.has(entry.runId)) keepRunIds.push(entry.runId);
  }

  candidates.forEach((entry, index) => {
    const ageMs = input.now - entry.mtimeMs;
    const staleByTtl = input.retentionMs > 0 && ageMs > input.retentionMs;
    const staleByCount = maxCount != null && index >= maxCount;
    if (staleByTtl || staleByCount) {
      deleteRunIds.push(entry.runId);
    } else {
      keepRunIds.push(entry.runId);
    }
  });

  return { deleteRunIds, keepRunIds };
}

function parseBooleanFlag(value: string | undefined): boolean {
  if (value == null) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseNonNegativeNumber(value: string | undefined): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read the run-workspace GC policy from the environment. Mirrors the `database.backup.retentionDays`
 * convention of being config/env driven with a safe default.
 *
 * - `PAPERCLIP_KEEP_RUN_WORKSPACE` — truthy keeps completed run workspaces (debugging opt-out).
 * - `PAPERCLIP_RUN_WORKSPACE_GC_DISABLED` — truthy disables the sweep.
 * - `PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS` — TTL in hours (default 24). `0` disables the TTL rule.
 * - `PAPERCLIP_RUN_WORKSPACE_MAX_COUNT` — optional cap on retained terminal run dirs.
 */
export function readRunWorkspaceGcConfig(env: NodeJS.ProcessEnv = process.env): RunWorkspaceGcConfig {
  const retentionHours = parseNonNegativeNumber(env.PAPERCLIP_RUN_WORKSPACE_RETENTION_HOURS);
  const maxCount = parseNonNegativeNumber(env.PAPERCLIP_RUN_WORKSPACE_MAX_COUNT);
  return {
    keepOnCompletion: parseBooleanFlag(env.PAPERCLIP_KEEP_RUN_WORKSPACE),
    sweepEnabled: !parseBooleanFlag(env.PAPERCLIP_RUN_WORKSPACE_GC_DISABLED),
    retentionMs: (retentionHours ?? DEFAULT_RUN_WORKSPACE_RETENTION_HOURS) * 60 * 60 * 1000,
    maxCount: maxCount == null ? null : Math.trunc(maxCount),
  };
}

/** Absolute POSIX path of the `.paperclip-runtime/runs` directory for a workspace base dir. */
export function runsRootRemoteDir(baseWorkspaceRemoteDir: string): string {
  return path.posix.join(baseWorkspaceRemoteDir, ...RUNTIME_RUNS_DIR_SEGMENTS);
}

/** Parse the tab-separated `<runId>\t<mtime-epoch-seconds>` listing emitted by the remote sweep. */
export function parseRunWorkspaceListing(stdout: string): RunWorkspaceEntry[] {
  const entries: RunWorkspaceEntry[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.lastIndexOf("\t");
    if (tab < 0) continue;
    const runId = line.slice(0, tab).trim();
    const seconds = Number(line.slice(tab + 1).trim());
    if (!runId || !Number.isFinite(seconds)) continue;
    entries.push({ runId, mtimeMs: seconds * 1000 });
  }
  return entries;
}

// Only ever operate on plain run-id path segments so a crafted listing can never turn into a
// traversal / glob outside the runs root.
const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/;

function isSafeRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId) && runId !== "." && runId !== "..";
}

/** List the immediate `<runId>` directories under the remote runs root with their mtimes. */
export async function listRemoteRunWorkspaces(input: {
  spec: SshRemoteExecutionSpec;
  runsRootRemoteDir: string;
  timeoutMs?: number;
}): Promise<RunWorkspaceEntry[]> {
  const dir = shellQuote(input.runsRootRemoteDir);
  // Portable across GNU coreutils (`stat -c %Y`) and BSD/macOS (`stat -f %m`). A missing runs root
  // just means there is nothing to collect yet.
  const script =
    `if [ ! -d ${dir} ]; then exit 0; fi; ` +
    `for d in ${dir}/*/; do ` +
    `[ -d "$d" ] || continue; ` +
    `name=$(basename "$d"); ` +
    `m=$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null || echo 0); ` +
    `printf '%s\\t%s\\n' "$name" "$m"; ` +
    `done`;
  const result = await runSshCommand(input.spec, script, {
    timeoutMs: input.timeoutMs ?? 20_000,
    maxBuffer: 1024 * 1024,
  });
  return parseRunWorkspaceListing(result.stdout);
}

/** Remove the given `<runId>` directories (and their contents) under the remote runs root. */
export async function removeRemoteRunWorkspaces(input: {
  spec: SshRemoteExecutionSpec;
  runsRootRemoteDir: string;
  runIds: string[];
  timeoutMs?: number;
}): Promise<void> {
  const safe = input.runIds.filter(isSafeRunId);
  if (safe.length === 0) return;
  const root = input.runsRootRemoteDir.replace(/\/+$/, "");
  const quoted = safe.map((id) => shellQuote(path.posix.join(root, id))).join(" ");
  await runSshCommand(input.spec, `rm -rf -- ${quoted}`, {
    timeoutMs: input.timeoutMs ?? 30_000,
    maxBuffer: 256 * 1024,
  });
}

/**
 * List, select, and remove stale terminal run workspaces under the remote runs root. Best-effort:
 * callers should treat this as opportunistic and not let a failure abort the run it guards.
 */
export async function sweepRemoteRunWorkspaces(input: {
  spec: SshRemoteExecutionSpec;
  runsRootRemoteDir: string;
  config: RunWorkspaceGcConfig;
  now: number;
  activeRunIds?: Iterable<string>;
}): Promise<{ deletedRunIds: string[] }> {
  if (!input.config.sweepEnabled) return { deletedRunIds: [] };
  const entries = await listRemoteRunWorkspaces({
    spec: input.spec,
    runsRootRemoteDir: input.runsRootRemoteDir,
  });
  const selection = selectRunWorkspacesForGc({
    entries,
    activeRunIds: input.activeRunIds,
    retentionMs: input.config.retentionMs,
    maxCount: input.config.maxCount,
    now: input.now,
  });
  await removeRemoteRunWorkspaces({
    spec: input.spec,
    runsRootRemoteDir: input.runsRootRemoteDir,
    runIds: selection.deleteRunIds,
  });
  return { deletedRunIds: selection.deleteRunIds };
}
