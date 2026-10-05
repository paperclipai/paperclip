import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export const HEARTBEAT_RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";
export const HEARTBEAT_TASK_SCRATCH_MARKER = ".paperclip-task-scratch.json";
/**
 * One lease file per run that is currently using the task directory. A sweep
 * defers while any lease is live, so closing an issue cannot delete files from
 * under a command that is still running.
 */
export const HEARTBEAT_TASK_SCRATCH_LEASE_PREFIX = ".paperclip-task-lease-";
/**
 * Written by a sweep that had to defer. The last lease to be released finds it
 * and completes the removal the sweep could not.
 */
export const HEARTBEAT_TASK_SCRATCH_CLOSED_MARKER = ".paperclip-task-scratch-closed.json";

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
  /**
   * Refreshed every time a heartbeat adopts the directory. A sweep carries the
   * time of the terminal transition that queued it and refuses to remove a
   * directory a heartbeat adopted after that, so an issue reopened between the
   * commit and the sweep keeps the material its new run is already using.
   */
  lastPreparedAt: string;
}

export interface HeartbeatTaskScratch {
  dir: string;
  markerPath: string;
  metadata: HeartbeatTaskScratchMetadata;
  /** The run that holds a lease on the directory, when one was taken. */
  leaseRunId: string | null;
}

export type HeartbeatTaskScratchCleanupReason =
  | "missing"
  | "unmarked"
  | "owner_mismatch"
  | "outside_root"
  /** A marker is present but cannot be verified, so ownership was never established. */
  | "marker_unverifiable"
  /** A run still holds a lease; removal is deferred to the release of the last one. */
  | "run_active"
  /** A heartbeat adopted the directory after the transition that queued this sweep. */
  | "reopened";

export type HeartbeatTaskScratchCleanupResult =
  | { removed: true; dir: string }
  | { removed: false; dir: string; reason: HeartbeatTaskScratchCleanupReason };

export interface HeartbeatTaskScratchSweepResult {
  root: string;
  removed: string[];
  deferred: string[];
  skipped: { dir: string; reason: HeartbeatTaskScratchCleanupReason }[];
}

interface HeartbeatTaskScratchLease {
  version: 1;
  runId: string;
  /** The server process that took the lease. A lease never outlives it. */
  serverPid: number;
  createdAt: string;
}

export type HeartbeatTaskScratchLeaseReleaseResult = {
  dir: string;
  released: boolean;
  /** A deferred sweep was waiting on this lease and has now been completed. */
  deferredCleanup: HeartbeatTaskScratchCleanupResult | null;
};

const TEMP_ENV_KEYS = ["TMPDIR", "TEMP", "TMP"] as const;
const ISSUE_SEGMENT_MAX_CHARS = 32;
const TASK_SCRATCH_ROOT_SEGMENT = "task-scratch";
/**
 * A lease is released by the same server process that took it, so one that
 * outlives its process is already stale. The age bound is the backstop for a
 * process id the operating system has since handed to something else.
 */
const TASK_SCRATCH_LEASE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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

/**
 * A marker that is absent and a marker that cannot be read or parsed are not
 * the same thing. Only the first means the directory is unclaimed. Treating the
 * second as unclaimed would let preparation overwrite a damaged marker with the
 * current owner's and so manufacture the permission a later sweep needs to
 * delete contents whose owner was never established.
 */
type HeartbeatTaskMarkerRead =
  | { state: "ok"; metadata: HeartbeatTaskScratchMetadata }
  | { state: "missing" }
  | { state: "invalid"; detail: string };

function isMissingFileError(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

async function readTaskMarker(markerPath: string): Promise<HeartbeatTaskMarkerRead> {
  let raw: string;
  try {
    raw = await fs.readFile(markerPath, "utf8");
  } catch (err) {
    if (isMissingFileError(err)) return { state: "missing" };
    return { state: "invalid", detail: `unreadable: ${(err as Error)?.message ?? String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { state: "invalid", detail: `unparsable: ${(err as Error)?.message ?? String(err)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { state: "invalid", detail: "not an object" };
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.version !== 1) return { state: "invalid", detail: `unsupported version ${String(rec.version)}` };
  if (
    typeof rec.companyId !== "string" ||
    typeof rec.agentId !== "string" ||
    typeof rec.issueId !== "string" ||
    typeof rec.createdAt !== "string"
  ) {
    return { state: "invalid", detail: "missing required fields" };
  }
  return {
    state: "ok",
    metadata: {
      version: 1,
      companyId: rec.companyId,
      agentId: rec.agentId,
      issueId: rec.issueId,
      issueIdentifier: typeof rec.issueIdentifier === "string" ? rec.issueIdentifier : null,
      createdAt: rec.createdAt,
      // Markers written before this field existed carry their creation time as
      // their last preparation, which is the truth for a directory no later
      // heartbeat has adopted.
      lastPreparedAt:
        typeof rec.lastPreparedAt === "string" ? rec.lastPreparedAt : rec.createdAt,
    },
  };
}

async function writeTaskMarker(
  markerPath: string,
  metadata: HeartbeatTaskScratchMetadata,
): Promise<void> {
  await fs.writeFile(markerPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
}

function parseTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // A live process this server may not signal still counts as live.
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function leaseFileName(runId: string): string {
  return `${HEARTBEAT_TASK_SCRATCH_LEASE_PREFIX}${assertTaskScratchIdSegment("runId", runId)}.json`;
}

/**
 * Count the leases that still stand for a running command. A lease whose server
 * process is gone was never released because that process died, and a lease
 * older than the bound is treated the same way, so a crash cannot pin a task
 * directory for good.
 */
async function countLiveTaskLeases(input: {
  dir: string;
  isProcessAlive: (pid: number) => boolean;
  now: Date;
  excludeRunId?: string | null;
}): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(input.dir);
  } catch {
    return 0;
  }
  const excluded = input.excludeRunId ? leaseFileName(input.excludeRunId) : null;
  let live = 0;
  for (const entry of entries) {
    if (!entry.startsWith(HEARTBEAT_TASK_SCRATCH_LEASE_PREFIX)) continue;
    if (excluded && entry === excluded) continue;
    const leasePath = path.join(input.dir, entry);
    let lease: HeartbeatTaskScratchLease | null = null;
    try {
      const parsed = JSON.parse(await fs.readFile(leasePath, "utf8")) as Record<string, unknown>;
      if (
        parsed?.version === 1 &&
        typeof parsed.runId === "string" &&
        typeof parsed.serverPid === "number" &&
        typeof parsed.createdAt === "string"
      ) {
        lease = parsed as unknown as HeartbeatTaskScratchLease;
      }
    } catch {
      lease = null;
    }
    if (!lease) {
      // An unreadable lease says nothing about a running command, and leaving
      // it live would pin the directory until the age bound. Drop it.
      await fs.rm(leasePath, { force: true }).catch(() => undefined);
      continue;
    }
    const createdAt = parseTimestamp(lease.createdAt);
    const expired =
      createdAt === null || input.now.getTime() - createdAt > TASK_SCRATCH_LEASE_STALE_AFTER_MS;
    if (expired || !input.isProcessAlive(lease.serverPid)) {
      await fs.rm(leasePath, { force: true }).catch(() => undefined);
      continue;
    }
    live += 1;
  }
  return live;
}

/**
 * Refuse a path whose company, agent or issue component is a link. The textual
 * containment check below cannot see through one: a linked component would let
 * preparation write a valid marker outside the task-scratch root and so let a
 * sweep remove files that were never ours.
 */
async function findLinkedPathComponent(root: string, dir: string): Promise<string | null> {
  const relative = path.relative(root, dir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return dir;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) return current;
    } catch (err) {
      // A component that does not exist yet cannot be a link.
      if (isMissingFileError(err)) return null;
      return current;
    }
  }
  return null;
}

/**
 * The link check above covers the components this module creates. This covers
 * the rest of the path: if the root itself resolves elsewhere, both sides
 * resolve the same way and the comparison still holds.
 */
async function isResolvedPathInside(root: string, dir: string): Promise<boolean> {
  try {
    const [resolvedRoot, resolvedDir] = await Promise.all([fs.realpath(root), fs.realpath(dir)]);
    return isPathInside(resolvedRoot, resolvedDir) && resolvedRoot !== resolvedDir;
  } catch (err) {
    // Nothing to contain when the directory is already gone.
    if (isMissingFileError(err)) return true;
    return false;
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
  /** Takes a lease for this run, so a sweep defers while the run is executing. */
  runId?: string | null;
  serverPid?: number;
  now?: Date;
}): Promise<HeartbeatTaskScratch> {
  const companyId = assertTaskScratchIdSegment("companyId", input.companyId);
  const agentId = assertTaskScratchIdSegment("agentId", input.agentId);
  const issueId = assertTaskScratchIdSegment("issueId", input.issueId);
  const root = resolveHeartbeatTaskScratchRoot({ instanceRoot: input.instanceRoot });
  const dir = resolveHeartbeatTaskScratchDir({
    companyId,
    agentId,
    issueId,
    instanceRoot: input.instanceRoot,
  });
  // Before creating anything: a recursive mkdir follows a linked component and
  // would plant a directory outside the root that a later sweep walks into.
  const linkedBefore = await findLinkedPathComponent(root, dir);
  if (linkedBefore) {
    throw new Error(`Task scratch path component '${linkedBefore}' is a link and will not be used.`);
  }
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // And again afterwards, so a component linked between the two checks is
  // caught before a marker is written into whatever it points at.
  const linkedAfter = await findLinkedPathComponent(root, dir);
  if (linkedAfter) {
    throw new Error(`Task scratch path component '${linkedAfter}' is a link and will not be used.`);
  }
  if (!(await isResolvedPathInside(root, dir))) {
    throw new Error(`Task scratch directory '${dir}' resolves outside '${root}'.`);
  }

  const markerPath = path.join(dir, HEARTBEAT_TASK_SCRATCH_MARKER);
  const now = input.now ?? new Date();
  const existing = await readTaskMarker(markerPath);
  if (existing.state === "invalid") {
    // Overwriting it would make this run the recorded owner of material whose
    // real owner was never established, and a later sweep would then delete it.
    throw new Error(
      `Task scratch directory '${dir}' has a marker that cannot be verified (${existing.detail}).`,
    );
  }

  let metadata: HeartbeatTaskScratchMetadata;
  if (existing.state === "ok") {
    if (
      existing.metadata.companyId !== companyId ||
      existing.metadata.agentId !== agentId ||
      existing.metadata.issueId !== issueId
    ) {
      // The path is derived from exactly these three identifiers, so a marker
      // that names different ones means the directory is not ours. Refuse it
      // rather than serve another owner's material to this run.
      throw new Error(`Task scratch directory '${dir}' is marked for a different owner.`);
    }
    // Adoption keeps the original creation time and records this one, which is
    // what tells a sweep queued by an earlier close that the task is live again.
    metadata = { ...existing.metadata, lastPreparedAt: now.toISOString() };
  } else {
    metadata = {
      version: 1,
      companyId,
      agentId,
      issueId,
      issueIdentifier: input.issueIdentifier ?? null,
      createdAt: now.toISOString(),
      lastPreparedAt: now.toISOString(),
    };
  }
  await writeTaskMarker(markerPath, metadata);

  const runId = input.runId?.trim() || null;
  if (runId) {
    const lease: HeartbeatTaskScratchLease = {
      version: 1,
      runId,
      serverPid: input.serverPid ?? process.pid,
      createdAt: now.toISOString(),
    };
    await fs.writeFile(path.join(dir, leaseFileName(runId)), `${JSON.stringify(lease)}\n`, {
      mode: 0o600,
    });
    // A close that landed while this heartbeat was starting must not be
    // completed by the lease this run is about to release: the task is live.
    await fs.rm(path.join(dir, HEARTBEAT_TASK_SCRATCH_CLOSED_MARKER), { force: true }).catch(
      () => undefined,
    );
  }

  return { dir, markerPath, metadata, leaseRunId: runId };
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
  /**
   * The time of the terminal transition this removal serves. A directory a
   * heartbeat adopted after it belongs to a task that is open again.
   */
  closedAt?: Date | null;
  /** The lease being released, which must not count against its own removal. */
  releasingRunId?: string | null;
  isProcessAlive?: (pid: number) => boolean;
  now?: Date;
}): Promise<HeartbeatTaskScratchCleanupResult> {
  const root = path.resolve(input.root);
  const dir = path.join(root, input.companyId, input.agentId, input.issueId);
  if (!isPathInside(root, dir) || dir === root) {
    return { removed: false, dir, reason: "outside_root" };
  }
  const linked = await findLinkedPathComponent(root, dir);
  if (linked) return { removed: false, dir, reason: "outside_root" };
  try {
    // lstat, not stat: a link that points at a directory elsewhere must be
    // refused rather than followed into a tree we may not remove.
    const stats = await fs.lstat(dir);
    if (stats.isSymbolicLink()) return { removed: false, dir, reason: "outside_root" };
    if (!stats.isDirectory()) return { removed: false, dir, reason: "missing" };
  } catch {
    return { removed: false, dir, reason: "missing" };
  }
  if (!(await isResolvedPathInside(root, dir))) {
    return { removed: false, dir, reason: "outside_root" };
  }

  const marker = await readTaskMarker(path.join(dir, HEARTBEAT_TASK_SCRATCH_MARKER));
  if (marker.state === "missing") return { removed: false, dir, reason: "unmarked" };
  if (marker.state === "invalid") return { removed: false, dir, reason: "marker_unverifiable" };
  if (
    marker.metadata.companyId !== input.companyId ||
    marker.metadata.agentId !== input.agentId ||
    marker.metadata.issueId !== input.issueId
  ) {
    return { removed: false, dir, reason: "owner_mismatch" };
  }

  const now = input.now ?? new Date();
  if (input.closedAt) {
    const lastPreparedAt = parseTimestamp(marker.metadata.lastPreparedAt);
    // An unreadable preparation time is treated as newer than the close: the
    // cost of keeping a directory is disk, the cost of removing a live one is
    // the task's work.
    if (lastPreparedAt === null || lastPreparedAt > input.closedAt.getTime()) {
      return { removed: false, dir, reason: "reopened" };
    }
  }

  const liveLeases = await countLiveTaskLeases({
    dir,
    isProcessAlive: input.isProcessAlive ?? defaultIsProcessAlive,
    now,
    excludeRunId: input.releasingRunId ?? null,
  });
  if (liveLeases > 0) {
    // Defer rather than delete under a running command, and leave the note the
    // last lease release needs to finish the job.
    await fs
      .writeFile(
        path.join(dir, HEARTBEAT_TASK_SCRATCH_CLOSED_MARKER),
        `${JSON.stringify({ version: 1, closedAt: (input.closedAt ?? now).toISOString() })}\n`,
        { mode: 0o600 },
      )
      .catch(() => undefined);
    return { removed: false, dir, reason: "run_active" };
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

async function readClosedMarkerAt(dir: string): Promise<Date | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(dir, HEARTBEAT_TASK_SCRATCH_CLOSED_MARKER), "utf8"),
    ) as Record<string, unknown>;
    if (typeof parsed?.closedAt !== "string") return null;
    const at = parseTimestamp(parsed.closedAt);
    return at === null ? null : new Date(at);
  } catch {
    return null;
  }
}

/**
 * Release this run's lease at run teardown and, when a sweep deferred to it and
 * no other run is still using the directory, complete that sweep. This is the
 * second half of the deferral: without it a task closed while a run was working
 * would keep its directory until the next close.
 */
export async function releaseHeartbeatTaskScratchLease(input: {
  scratch: HeartbeatTaskScratch;
  instanceRoot?: string;
  isProcessAlive?: (pid: number) => boolean;
  now?: Date;
}): Promise<HeartbeatTaskScratchLeaseReleaseResult> {
  const dir = path.resolve(input.scratch.dir);
  const runId = input.scratch.leaseRunId;
  if (!runId) return { dir, released: false, deferredCleanup: null };

  let released = false;
  try {
    await fs.rm(path.join(dir, leaseFileName(runId)), { force: true });
    released = true;
  } catch {
    released = false;
  }

  const closedAt = await readClosedMarkerAt(dir);
  if (!closedAt) return { dir, released, deferredCleanup: null };

  const root = resolveHeartbeatTaskScratchRoot({ instanceRoot: input.instanceRoot });
  const { companyId, agentId, issueId } = input.scratch.metadata;
  if (
    !TASK_SCRATCH_ID_SEGMENT_RE.test(companyId) ||
    !TASK_SCRATCH_ID_SEGMENT_RE.test(agentId) ||
    !TASK_SCRATCH_ID_SEGMENT_RE.test(issueId) ||
    dir !== path.join(root, companyId, agentId, issueId)
  ) {
    return { dir, released, deferredCleanup: { removed: false, dir, reason: "outside_root" } };
  }

  const deferredCleanup = await removeHeartbeatTaskScratchDir({
    root,
    companyId,
    agentId,
    issueId,
    closedAt,
    releasingRunId: runId,
    isProcessAlive: input.isProcessAlive,
    now: input.now,
  });
  if (deferredCleanup.removed) await pruneEmptyDir(path.join(root, companyId, agentId));
  return { dir, released, deferredCleanup };
}

export async function cleanupHeartbeatTaskScratch(input: {
  scratch: HeartbeatTaskScratch;
  instanceRoot?: string;
  closedAt?: Date | null;
  isProcessAlive?: (pid: number) => boolean;
  now?: Date;
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
  return removeHeartbeatTaskScratchDir({
    root,
    companyId,
    agentId,
    issueId,
    closedAt: input.closedAt ?? null,
    releasingRunId: input.scratch.leaseRunId,
    isProcessAlive: input.isProcessAlive,
    now: input.now,
  });
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
  /**
   * The time of the terminal transition that queued this sweep. A directory a
   * heartbeat adopted after it is kept: the issue was reopened while the sweep
   * was in flight, and its material belongs to the run that is using it now.
   */
  closedAt?: Date | null;
  isProcessAlive?: (pid: number) => boolean;
  now?: Date;
}): Promise<HeartbeatTaskScratchSweepResult> {
  const companyId = assertTaskScratchIdSegment("companyId", input.companyId);
  const issueId = assertTaskScratchIdSegment("issueId", input.issueId);
  const root = resolveHeartbeatTaskScratchRoot({ instanceRoot: input.instanceRoot });
  const result: HeartbeatTaskScratchSweepResult = { root, removed: [], deferred: [], skipped: [] };

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
      closedAt: input.closedAt ?? null,
      isProcessAlive: input.isProcessAlive,
      now: input.now,
    });
    if (outcome.removed) {
      result.removed.push(outcome.dir);
      await pruneEmptyDir(path.join(companyDir, agentEntry));
      continue;
    }
    if (outcome.reason === "run_active") {
      // Not a failure: the release of the last lease completes it.
      result.deferred.push(outcome.dir);
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
