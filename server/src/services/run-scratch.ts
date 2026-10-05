import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";
export const HEARTBEAT_TASK_SCRATCH_MARKER = ".paperclip-task-scratch.json";

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

/**
 * Task scratch is the durable half of the pair. A run directory is an
 * `mkdtemp` under the system temp root and is removed when the run ends, so
 * nothing an agent needs across heartbeats can live there. Before this existed
 * the only directory that outlived a heartbeat was the execution workspace,
 * which is also the tree the workspace sync ships, so durable working material
 * had to be parked inside a payload.
 */
export interface HeartbeatTaskScratchMetadata {
  version: 1;
  companyId: string;
  agentId: string;
  issueId: string;
  issueIdentifier: string | null;
  createdAt: string;
}

export interface HeartbeatTaskScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatTaskScratchMetadata;
}

export type HeartbeatTaskScratchCleanupReason =
  | "missing"
  | "unmarked"
  | "owner_mismatch"
  | "outside_root";

export type HeartbeatTaskScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: HeartbeatTaskScratchCleanupReason };

export interface HeartbeatTaskScratchSweepResult {
  root: string;
  removed: string[];
  skipped: { dir: string; reason: HeartbeatTaskScratchCleanupReason }[];
}

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;
const TASK_SCRATCH_ROOT_SEGMENT = "task-scratch";

// Identifiers reach these paths from the database, where they are uuids. The
// guard is here so a malformed identifier can never escape the task-scratch
// root: the leading character class rejects "." and "..", and the class as a
// whole rejects separators on both posix and win32.
const TASK_SCRATCH_ID_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertTaskScratchIdSegment(label: string, value: string): string {
  const trimmed = value.trim();
  if (!TASK_SCRATCH_ID_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} for task scratch path '${value}'.`);
  }
  return trimmed;
}

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

async function readTaskMarker(markerPath: string): Promise<HeartbeatTaskScratchMetadata | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(markerPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    if (
      rec.version !== 1 ||
      typeof rec.companyId !== "string" ||
      typeof rec.agentId !== "string" ||
      typeof rec.issueId !== "string" ||
      typeof rec.createdAt !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      issueId: rec.issueId,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * The root for every task scratch directory: a subdirectory of the Paperclip
 * instance root, which survives a restart and is a sibling of the workspace
 * tree rather than a part of it, so nothing here can enter a sync payload.
 */
export function resolveHeartbeatTaskScratchRoot(input: { instanceRoot?: string } = {}): string {
  const root = input.instanceRoot?.trim();
  return path.resolve(root || resolvePaperclipInstanceRoot(), TASK_SCRATCH_ROOT_SEGMENT);
}

/**
 * Resolve the one directory that belongs to this company, agent and issue.
 * The path is a pure function of those three identifiers, so every heartbeat of
 * the same task resolves to the same directory.
 */
export function resolveHeartbeatTaskScratchDir(input: {
  companyId: string;
  agentId: string;
  issueId: string;
  instanceRoot?: string;
}): string {
  return path.join(
    resolveHeartbeatTaskScratchRoot({ instanceRoot: input.instanceRoot }),
    assertTaskScratchIdSegment("companyId", input.companyId),
    assertTaskScratchIdSegment("agentId", input.agentId),
    assertTaskScratchIdSegment("issueId", input.issueId),
  );
}

/**
 * Create or adopt the task scratch directory. Adoption is the common case: the
 * first heartbeat of a task writes the marker, and every later heartbeat finds
 * the directory and its contents already there and keeps the original
 * `createdAt`.
 */
export async function prepareHeartbeatTaskScratch(input: {
  companyId: string;
  agentId: string;
  issueId: string;
  issueIdentifier?: string | null;
  instanceRoot?: string;
  now?: Date;
}): Promise<HeartbeatTaskScratch> {
  const companyId = assertTaskScratchIdSegment("companyId", input.companyId);
  const agentId = assertTaskScratchIdSegment("agentId", input.agentId);
  const issueId = assertTaskScratchIdSegment("issueId", input.issueId);
  const dir = resolveHeartbeatTaskScratchDir({
    companyId,
    agentId,
    issueId,
    instanceRoot: input.instanceRoot,
  });
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const markerPath = path.join(dir, HEARTBEAT_TASK_SCRATCH_MARKER);

  const existing = await readTaskMarker(markerPath);
  if (existing) {
    if (
      existing.companyId !== companyId ||
      existing.agentId !== agentId ||
      existing.issueId !== issueId
    ) {
      // The path is derived from exactly these three identifiers, so a marker
      // that names different ones means the directory is not ours. Refuse it
      // rather than serve another owner's material to this run.
      throw new Error(`Task scratch directory '${dir}' is marked for a different owner.`);
    }
    return { dir, markerPath, metadata: existing };
  }

  const metadata: HeartbeatTaskScratchMetadata = {
    version: 1,
    companyId,
    agentId,
    issueId,
    issueIdentifier: input.issueIdentifier ?? null,
    createdAt: (input.now ?? new Date()).toISOString(),
  };
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { dir, markerPath, metadata };
}

/**
 * Remove one task scratch directory. The ownership check is the task-scoped
 * equivalent of the run-scoped one in `cleanupHeartbeatRunScratch`: there it is
 * keyed on the run id, here on company, agent and issue, all three of which
 * must match both the path and the marker inside it.
 */
async function removeHeartbeatTaskScratchDir(input: {
  root: string;
  companyId: string;
  agentId: string;
  issueId: string;
}): Promise<HeartbeatTaskScratchCleanupResult> {
  const root = path.resolve(input.root);
  const dir = path.join(root, input.companyId, input.agentId, input.issueId);
  if (!isPathInside(root, dir) || dir === root) {
    return { removed: false, dir, reason: "outside_root" };
  }
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }

  const marker = await readTaskMarker(path.join(dir, HEARTBEAT_TASK_SCRATCH_MARKER));
  if (!marker) return { removed: false, dir, reason: "unmarked" };
  if (
    marker.companyId !== input.companyId ||
    marker.agentId !== input.agentId ||
    marker.issueId !== input.issueId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

export async function cleanupHeartbeatTaskScratch(input: {
  scratch: HeartbeatTaskScratch;
  instanceRoot?: string;
}): Promise<HeartbeatTaskScratchCleanupResult> {
  const root = resolveHeartbeatTaskScratchRoot({ instanceRoot: input.instanceRoot });
  const { companyId, agentId, issueId } = input.scratch.metadata;
  if (
    !TASK_SCRATCH_ID_SEGMENT_RE.test(companyId) ||
    !TASK_SCRATCH_ID_SEGMENT_RE.test(agentId) ||
    !TASK_SCRATCH_ID_SEGMENT_RE.test(issueId)
  ) {
    return { removed: false, dir: path.resolve(input.scratch.dir), reason: "outside_root" };
  }
  // The caller's directory must be the one the identifiers derive, so a handle
  // carrying a doctored path cannot redirect the removal.
  const expected = path.join(root, companyId, agentId, issueId);
  if (path.resolve(input.scratch.dir) !== expected) {
    return { removed: false, dir: path.resolve(input.scratch.dir), reason: "outside_root" };
  }
  return removeHeartbeatTaskScratchDir({ root, companyId, agentId, issueId });
}

async function pruneEmptyDir(dir: string): Promise<void> {
  // rmdir removes the directory only while it is empty, so a concurrent
  // heartbeat that just created a sibling task directory is never disturbed.
  await fs.rmdir(dir).catch(() => undefined);
}

/**
 * Sweep every agent's task scratch for one issue. This is what runs when an
 * issue reaches a terminal state: the directory outlives any single run, so a
 * run-end sweep would be both too early and, for an issue closed without a run,
 * never. More than one agent can work one issue, so each agent directory under
 * the company is checked for this issue's directory.
 */
export async function sweepHeartbeatTaskScratchForIssue(input: {
  companyId: string;
  issueId: string;
  instanceRoot?: string;
}): Promise<HeartbeatTaskScratchSweepResult> {
  const companyId = assertTaskScratchIdSegment("companyId", input.companyId);
  const issueId = assertTaskScratchIdSegment("issueId", input.issueId);
  const root = resolveHeartbeatTaskScratchRoot({ instanceRoot: input.instanceRoot });
  const result: HeartbeatTaskScratchSweepResult = { root, removed: [], skipped: [] };

  const companyDir = path.join(root, companyId);
  let agentEntries: string[];
  try {
    agentEntries = await fs.readdir(companyDir);
  } catch {
    // No agent of this company has ever had a task directory here.
    return result;
  }

  for (const agentEntry of agentEntries) {
    if (!TASK_SCRATCH_ID_SEGMENT_RE.test(agentEntry)) continue;
    const outcome = await removeHeartbeatTaskScratchDir({
      root,
      companyId,
      agentId: agentEntry,
      issueId,
    });
    if (outcome.removed) {
      result.removed.push(outcome.dir);
      await pruneEmptyDir(path.join(companyDir, agentEntry));
      continue;
    }
    // A company directory holds one subdirectory per agent and each of those
    // one per issue, so most agents simply never worked this issue.
    if (outcome.reason !== "missing") result.skipped.push({ dir: outcome.dir, reason: outcome.reason });
  }

  if (result.removed.length > 0) await pruneEmptyDir(companyDir);
  return result;
}

export function buildHeartbeatRunScratchEnv(
  existingEnv: Record<string, unknown>,
  scratch: HeartbeatRunScratch,
  taskScratch?: HeartbeatTaskScratch | null,
): HeartbeatRunScratchEnvResult {
  const env: Record<string, string> = {
    PAPERCLIP_RUN_SCRATCH_DIR: scratch.dir,
    // Durable across the heartbeats of one task when a task directory exists.
    // A run without an issue has no task, so the variable falls back to the run
    // directory and is never unset.
    PAPERCLIP_TASK_SCRATCH_DIR: taskScratch?.dir ?? scratch.dir,
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

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}
