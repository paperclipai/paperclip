import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";

export interface HeartbeatRunScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatRunScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatRunScratchMetadata;
}

export interface HeartbeatRunScratchEnvResult {
  env: Record<string, string>;
  tempKeysApplied: string[];
}

export type HeartbeatRunScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" };

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;

function sanitizePathSegment(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ISSUE_SEGMENT_MAX_CHARS)
    .replace(/[.-]+$/g, "");
  return normalized || fallback;
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readMarker(markerPath: string): Promise<HeartbeatRunScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.runId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      runId: rec.runId,
      issueId: typeof rec.issueId === "string" ? rec.issueId : null,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
}): Promise<HeartbeatRunScratch> {
  const issueSegment = sanitizePathSegment(input.issueIdentifier, "unassigned");
  const runSegment = sanitizePathSegment(input.runId.slice(0, 12), "run");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-run-${issueSegment}-${runSegment}-`));
  const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
  const metadata: HeartbeatRunScratchMetadata = {
    version: 1,
    companyId: input.companyId,
    agentId: input.agentId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_SCRATCH_DIR: scratch.dir,
    PAPERCLIP_TMPDIR: scratch.dir,
  };
  const tempKeysApplied: string[] = [];
  for (const key of TEMP_ENV_KEYS) {
    const existing = existingEnv[key];
    if (typeof existing === "string" && existing.trim().length > 0) continue;
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
  /** Persist recovery evidence after ownership/liveness checks, before removal. */
  beforeRemove?: () => Promise<void>;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const tmpRoot = path.resolve(os.tmpdir());
  const dir = path.resolve(input.scratch.dir);
  if (!isPathInside(tmpRoot, dir) || !path.basename(dir).startsWith("paperclip-run-")) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.scratch.metadata.companyId ||
    marker.agentId !== input.scratch.metadata.agentId ||
    marker.runId !== input.scratch.metadata.runId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }
  if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
    return { removed: false, dir, reason: "process_group_alive" };
  }

  await input.beforeRemove?.();
  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

/** "unknown" means this instance cannot establish ownership; it is never removed. */
export type RunScratchSweepRunState = "terminal" | "active" | "unknown";

export interface SweepRunScratchResult {
  scanned: number;
  removed: string[];
  kept: number;
  truncated: boolean;
}

export const RUN_SCRATCH_SWEEP_MAX_SCAN = 500;
export const RUN_SCRATCH_SWEEP_MAX_REMOVE = 100;

// Instances with separate databases share the temp root, so a run absent from
// this instance's database may belong to another live instance. Keep those.
let sweepCursor = 0;

/**
 * Remove leftover run scratch directories whose owning run is terminal (or
 * whose run row is long gone). Earlier process attempts of a run that crossed
 * a restart leave directories that the live attempt's cleanup never sees.
 *
 * Safety: only real (non-symlink) `paperclip-run-*` directories directly under
 * the temp root, with a valid regular-file marker, are considered. Active runs
 * and unmarked directories are always kept. Work per sweep is bounded.
 */
export async function sweepOrphanedRunScratch(input: {
  resolveRunStates: (runIds: string[]) => Promise<Map<string, RunScratchSweepRunState>>;
  /** Restrict the sweep to one run's directories (used when that run ends). */
  runId?: string;
  tmpRoot?: string;
  maxScan?: number;
  maxRemove?: number;
}): Promise<SweepRunScratchResult> {
  const tmpRoot = path.resolve(input.tmpRoot ?? os.tmpdir());
  const maxScan = input.maxScan ?? RUN_SCRATCH_SWEEP_MAX_SCAN;
  const maxRemove = input.maxRemove ?? RUN_SCRATCH_SWEEP_MAX_REMOVE;
  const result: SweepRunScratchResult = { scanned: 0, removed: [], kept: 0, truncated: false };

  let entries: Dirent[];
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  // A per-run sweep pre-filters by the run segment of the directory name, so it
  // is not limited by unrelated entries. A global sweep rotates its start so
  // entries that are always kept cannot starve later ones.
  const runNeedle = input.runId !== undefined
    ? `-${sanitizePathSegment(input.runId.slice(0, 12), "run")}-`
    : null;
  const named = entries
    .filter((entry) =>
      entry.name.startsWith("paperclip-run-") && entry.isDirectory() && !entry.isSymbolicLink() &&
      (runNeedle === null || entry.name.includes(runNeedle)))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const start = runNeedle === null && named.length > 0 ? sweepCursor % named.length : 0;
  const candidates: Array<{ dir: string; marker: HeartbeatRunScratchMetadata }> = [];
  for (let i = 0; i < named.length; i += 1) {
    const entry = named[(start + i) % named.length]!;
    if (runNeedle === null && result.scanned >= maxScan) {
      result.truncated = true;
      sweepCursor = start + i;
      break;
    }
    result.scanned += 1;
    const dir = path.join(tmpRoot, entry.name);
    try {
      const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
      const markerStat = await fs.lstat(markerPath);
      if (!markerStat.isFile()) {
        result.kept += 1;
        continue;
      }
      const marker = await readMarker(markerPath);
      if (!marker || (input.runId !== undefined && marker.runId !== input.runId)) {
        result.kept += 1;
        continue;
      }
      candidates.push({ dir, marker });
    } catch {
      result.kept += 1;
    }
  }
  if (runNeedle === null && !result.truncated) sweepCursor = 0;
  if (candidates.length === 0) return result;

  const states = await input.resolveRunStates([...new Set(candidates.map((c) => c.marker.runId))]);
  for (const { dir, marker } of candidates) {
    const state = states.get(marker.runId) ?? "active";
    const removable = state === "terminal";
    if (!removable || result.removed.length >= maxRemove) {
      if (removable) result.truncated = true;
      result.kept += 1;
      continue;
    }
    try {
      // Re-check just before removal: never remove through a swapped symlink.
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        result.kept += 1;
        continue;
      }
      await fs.rm(dir, { recursive: true, force: true });
      result.removed.push(dir);
    } catch {
      result.kept += 1;
    }
  }
  return result;
}
