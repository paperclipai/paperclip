import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { retainedAiCredentialCleanupHomeInside } from "./retained-ai-credential-cleanup.js";

import {
  resolveWalkerOps, openVerifiedDirectory, removeEntriesWithinDevice, removeDirNameViaParent,
  type RunScratchWalkerOps, type RunScratchWalkerOpsOverride, type VerifiedDir,
} from "./run-scratch-walker.js";
export { createDefaultRunScratchWalkerOps } from "./run-scratch-walker.js";
export type { RunScratchAnchorMode, RunScratchWalkerOps, RunScratchWalkerOpsOverride } from "./run-scratch-walker.js";

import {
  HEARTBEAT_RUN_SCRATCH_MARKER, RUN_SCRATCH_QUARANTINE_RECEIPT,
  readMarker, readQuarantineReceipt, parseQuarantineReceipt,
  type HeartbeatRunScratchMetadata, type RunScratchQuarantineReceipt,
} from "./run-scratch-evidence.js";
export { HEARTBEAT_RUN_SCRATCH_MARKER, RUN_SCRATCH_QUARANTINE_RECEIPT } from "./run-scratch-evidence.js";
export type { HeartbeatRunScratchMetadata, RunScratchQuarantineReceipt } from "./run-scratch-evidence.js";
export const RUN_TEMP_ROOT_DIRNAME = ".pctmp";
export const RUN_TEMP_SEGMENT_CHARS = 8;

/** Absolute socket paths must stay far below the kernel's 107-byte sun_path limit. */
export const MAX_RUN_TEMP_SOCKET_PATH_BYTES = 107;

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
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_group_alive" | "ai_home_retained" | "symlink" | "mount_point_present" | "unsafe_tree" };

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

/**
 * Per-run scratch directories live on the instance's home filesystem, outside
 * any tmpfs the OS periodically reclaims, so a live run never loses its
 * PostgreSQL sockets or credential homes to a tmpfiles timer.
 */
export function runTempRoot(): string {
  return path.join(os.homedir(), RUN_TEMP_ROOT_DIRNAME);
}

/** Short, deterministic directory name derived from the run id. */
export function runTempSegment(runId: string): string {
  return sanitizePathSegment(runId.slice(0, RUN_TEMP_SEGMENT_CHARS), "run");
}

export function runTempDirPath(runId: string, root = runTempRoot()): string {
  return path.join(root, runTempSegment(runId));
}

/** The longest Unix-domain socket path a run's scratch directory may produce. */
export function runTempSocketPathBudget(runId: string, root = runTempRoot()): number {
  return Buffer.byteLength(path.join(runTempDirPath(runId, root), "x", ".s.PGSQL.65535"));
}

/**
 * Confine scratch operations to the roots this runner owns: the per-run temp
 * root (any direct child) and, for directories created before the migration,
 * the OS temp root with the historical `paperclip-run-` prefix.
 */
export function classifyRunScratchDir(dir: string, rootOverride?: string): "run_temp" | "tmp" | null {
  const resolved = path.resolve(dir);
  const tempRoot = path.resolve(rootOverride ?? runTempRoot());
  if (path.dirname(resolved) === tempRoot) return "run_temp";
  const tmpRoot = path.resolve(os.tmpdir());
  if (isPathInside(tmpRoot, resolved) && path.basename(resolved).startsWith("paperclip-run-")) return "tmp";
  return null;
}

export async function prepareHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  issueId?: string | null;
  issueIdentifier?: string | null;
  now?: Date;
  root?: string;
}): Promise<HeartbeatRunScratch> {
  const root = path.resolve(input.root ?? runTempRoot());
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700).catch(() => undefined);
  const segment = runTempSegment(input.runId);
  let dir = path.join(root, segment);
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // The deterministic name is either an earlier attempt of this same run
    // (safe to reuse) or a collision with a different run (fall back to a
    // short unique suffix so both runs keep working).
    const existing = await readMarker(path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER));
    if (!existing || existing.runId !== input.runId || existing.companyId !== input.companyId) {
      dir = await fs.mkdtemp(path.join(root, `${segment}-`));
    }
  }
  await fs.chmod(dir, 0o700).catch(() => undefined);
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
 * The run scratch directory is the authoritative temp directory for the agent
 * process: TMPDIR, TMP and TEMP always point at it so no CLI falls back to a
 * shared tmpfs location.
 */
export function buildHeartbeatRunScratchEnv(
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
    env[key] = scratch.dir;
    tempKeysApplied.push(key);
  }
  return { env, tempKeysApplied };
}

/**
 * Portable (non `/proc/self/fd`) completion of a verified directory removal.
 *
 * Path-based entry operations cannot address children of a held-open
 * directory on these platforms, so the removal never deletes through the
 * original name. Instead the directory — proven by identity first — is
 * atomically renamed to a fresh, unguessable sibling name and destroyed
 * there:
 *
 * - `rename` never traverses the moved name: if an attacker swapped it for a
 *   symlink between the identity proof and the rename, the symlink itself is
 *   moved and then unlinked; the foreign tree is never reached.
 * - Inside the quarantine name every entry operation is anchored to the
 *   held-open directory fd: the portable ops re-prove, synchronously right
 *   before each single-name syscall, that the working directory is still the
 *   inode the fd pins. A concurrent writer holding pre-quarantine fds can
 *   still rename children and plant symlinks inside the quarantined tree,
 *   but a redirected anchor is refused before any destructive syscall, and
 *   a proven anchor cannot resolve outside the pinned directory. Such a
 *   writer can only make the removal incomplete, never foreign.
 * - The quarantine name preserves the original segment prefix with a
 *   `-rm-<random>` suffix, so an interrupted removal stays discoverable by
 *   retries and sweeps long after the original name is gone.
 *
 * Returns the quarantine path the caller must operate on (the caller owns
 * removing it), or null when the removal cannot proceed fail-closed.
 */
const QUARANTINE_NAME_RE = /-rm-[0-9a-f]{16}$/;

/** Directories a quarantined removal of `dir` may leave behind for retries. */
export async function runScratchRemnantDirs(dir: string): Promise<string[]> {
  const parent = path.dirname(path.resolve(dir));
  const base = path.basename(path.resolve(dir));
  let entries: Dirent[];
  try {
    entries = await fs.readdir(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.startsWith(`${base}-rm-`))
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

/**
 * The pre-quarantine name path of a remnant. Retained homes and teardown
 * holds are registered by path, so a quarantine rename must never orphan
 * the protection: remnant gates evaluate it on the remnant AND on the
 * original name the protections were registered under.
 */
function quarantineOriginalPath(remnant: string): string {
  const resolved = path.resolve(remnant);
  return path.join(path.dirname(resolved), path.basename(resolved).replace(QUARANTINE_NAME_RE, ""));
}

/** True while any credential-home protection covers the remnant under either name. */
async function quarantineProtectionActive(remnant: string): Promise<boolean> {
  if (await retainedAiCredentialCleanupHomeInside(remnant)) return true;
  return retainedAiCredentialCleanupHomeInside(quarantineOriginalPath(remnant));
}

/**
 * A receipt name already present is normally foreign evidence a removal must
 * refuse — but this removal's own prior attempt may have written the receipt
 * and then lost the rename (a transient failure, or a crash between the
 * exclusive write and the rename). That receipt is exactly the evidence this
 * attempt is trying to write, so the quarantine may proceed against it:
 * nothing is overwritten, and only content matching this removal's own
 * identity (kind, owner, original name) is accepted. Anything else —
 * unreadable, foreign, or not a regular file — stays refuse.
 */
async function recoverOwnQuarantineReceipt(fd: number, ops: RunScratchWalkerOps, ours: RunScratchQuarantineReceipt): Promise<boolean> {
  const stats = await ops.lstatEntry(fd, RUN_SCRATCH_QUARANTINE_RECEIPT).catch(() => null);
  if (!stats || stats.isDirectory() || stats.isSymbolicLink()) return false;
  const data = await ops.readEntryRegular(fd, RUN_SCRATCH_QUARANTINE_RECEIPT, stats).catch(() => null);
  const existing = data === null ? null : parseQuarantineReceipt(data);
  if (!existing) return false;
  return (
    existing.kind === ours.kind &&
    existing.companyId === ours.companyId &&
    existing.agentId === ours.agentId &&
    existing.runId === ours.runId &&
    existing.originalName === ours.originalName
  );
}

async function quarantineRenameForPortableRemoval(
  dir: string,
  ops: RunScratchWalkerOps,
  receipt: RunScratchQuarantineReceipt,
): Promise<{ kind: "quarantined"; path: string } | { kind: "missing" } | { kind: "refused" }> {
  const verified = await openVerifiedDirectory(dir, ops).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw error;
    return null;
  });
  if (!verified) return { kind: "refused" };
  try {
    const parent = path.dirname(dir);
    const name = path.basename(dir);
    // A retry may find an earlier quarantine name: it already is a fresh
    // unguessable name proven by identity, so renaming again would only
    // orphan the previous suffix.
    if (!QUARANTINE_NAME_RE.test(name)) {
      // Retained homes and teardown holds are registered by path: a rename
      // would orphan the protection, because the registry cannot recognize
      // the moved inode under the quarantine name. Never quarantine a
      // protected tree — the removal refuses and the directory keeps its
      // original name, where every gate still finds the hold; the retry
      // after the hold is released performs the quarantine.
      if (await retainedAiCredentialCleanupHomeInside(dir)) return { kind: "refused" };
      // The quarantine receipt is the durable evidence later retries and
      // sweeps re-derive the removal's gates from: written exclusively
      // through the verified fd before the rename, it cannot overwrite a
      // planted name, and a tree that cannot carry it is never renamed.
      const receiptWritten = await ops
        .writeEntryExclusive(verified.fd, RUN_SCRATCH_QUARANTINE_RECEIPT, `${JSON.stringify(receipt, null, 2)}\n`, 0o600)
        .then(() => true, (error: NodeJS.ErrnoException) => error.code === "EEXIST" ? false : Promise.reject(error))
        .catch(() => null);
      if (receiptWritten === null || (!receiptWritten && !(await recoverOwnQuarantineReceipt(verified.fd, ops, receipt)))) return { kind: "refused" };
      const suffix = randomBytes(8).toString("hex");
      const quarantine = path.join(parent, `${name}-rm-${suffix}`);
      try {
        await fs.rename(dir, quarantine);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
        return { kind: "refused" };
      }
      // The rename moved whatever held the name. Only the proven directory may
      // be destroyed under the quarantine name; a moved link is unlinked
      // there — a link, never a foreign tree — while a suspicious directory
      // is moved out of the `-rm-` pattern first, so no retry or sweep can
      // ever mistake it for this directory's own quarantined remnant.
      const moved = await fs.lstat(quarantine).catch(() => null);
      if (
        !moved ||
        !moved.isDirectory() ||
        moved.isSymbolicLink() ||
        moved.dev !== verified.identity.dev ||
        moved.ino !== verified.identity.ino
      ) {
        if (moved?.isDirectory() && !moved.isSymbolicLink()) {
          await fs.rename(quarantine, path.join(parent, `${name}-suspect-${suffix}`)).catch(() => undefined);
        } else {
          await fs.unlink(quarantine).catch(() => undefined);
        }
        return { kind: "refused" };
      }
      return { kind: "quarantined", path: quarantine };
    }
    return { kind: "quarantined", path: dir };
  } finally {
    await ops.closeDir(verified.fd).catch(() => undefined);
  }
}

/**
 * Recursively remove a run temp tree (a managed AI home or another unmarked
 * leftover) without following symlinks and without crossing mount points.
 * Every entry operation is anchored to a directory fd held open for the
 * descent, so swapping any path component for a symlink cannot redirect a
 * deletion outside the tree. Platforms without `/proc/self/fd` first rename
 * the verified directory to a fresh quarantine sibling — carrying a
 * quarantine receipt — and destroy it there.
 *
 * An incomplete portable removal leaves the tree under a quarantine name
 * while callers keep retrying the original path, so absence of the original
 * never proves completion: the removal only completes when no quarantine
 * remnant of the directory remains either — and every remnant it reclaims
 * must carry this removal's receipt, so a foreign `-rm-` name is never
 * destroyed just for its shape. `quarantinePath` reports the effective path
 * an incomplete removal left behind, for callers that record cleanup state.
 */
export async function removeRunTempTree(
  dir: string,
  opts?: {
    walkerOps?: RunScratchWalkerOpsOverride;
    /** Identity of the tree's owner, recorded in the quarantine receipt. */
    quarantineReceipt?: { companyId?: string | null; agentId?: string | null; runId?: string | null };
  },
): Promise<{ complete: boolean; quarantinePath?: string }> {
  const ops = resolveWalkerOps(opts?.walkerOps);
  const resolvedDir = path.resolve(dir);
  if (await quarantineProtectionActive(resolvedDir)) {
    const [quarantinePath] = await runScratchRemnantDirs(dir);
    return { complete: false, ...(quarantinePath ? { quarantinePath } : {}) };
  }
  const receipt: RunScratchQuarantineReceipt = {
    version: 1,
    kind: "home",
    companyId: opts?.quarantineReceipt?.companyId ?? null,
    agentId: opts?.quarantineReceipt?.agentId ?? null,
    runId: opts?.quarantineReceipt?.runId ?? null,
    originalName: path.basename(resolvedDir).replace(QUARANTINE_NAME_RE, ""),
    createdAt: new Date().toISOString(),
  };
  const clearRemnants = async (exclude?: string): Promise<{ complete: boolean; quarantinePath?: string }> => {
    for (const remnant of await runScratchRemnantDirs(dir)) {
      if (remnant === exclude) continue;
      // Protections survive the rename: a retained credential home inside
      // the remnant keeps the whole tree until the write-back settles —
      // under the remnant name or the original name the hold was
      // registered under.
      if (await quarantineProtectionActive(remnant)) {
        return { complete: false, quarantinePath: remnant };
      }
      // A `-rm-` shape alone is not authorization to destroy a tree: only
      // this removal's own receipt — written through the verified directory
      // before its quarantine rename — ties the remnant back to a gated
      // cleanup this runner started.
      const remnantBase = path.basename(path.resolve(remnant)).replace(QUARANTINE_NAME_RE, "");
      const receipt = await readQuarantineReceipt(path.join(remnant, RUN_SCRATCH_QUARANTINE_RECEIPT)).catch(() => null);
      if (!receipt || receipt.originalName !== remnantBase) {
        return { complete: false, quarantinePath: remnant };
      }
      const cleared = await removeMarkedRunScratchDir(remnant, null, opts?.walkerOps)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return { complete: true } as const;
          return null;
        });
      if (cleared?.complete !== true) return { complete: false, quarantinePath: remnant };
    }
    return { complete: true };
  };
  if ((await ops.resolveAnchoring()) !== "procfd") {
    const quarantine = await quarantineRenameForPortableRemoval(dir, ops, receipt).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return { kind: "missing" } as const;
        throw error;
      },
    );
    if (quarantine.kind === "missing") return clearRemnants();
    if (quarantine.kind === "refused") {
      // The original name could not be proven; earlier remnants are still
      // this directory's unfinished work and must keep the result open.
      const remnants = await clearRemnants();
      return remnants.complete ? { complete: false } : remnants;
    }
    if (!(await removeMarkedRunScratchDir(quarantine.path, null, opts?.walkerOps)).complete) {
      return { complete: false, quarantinePath: quarantine.path };
    }
    return clearRemnants(quarantine.path);
  }
  try {
    const destroyed = await removeMarkedRunScratchDir(dir, null, opts?.walkerOps);
    if (!destroyed.complete) return { complete: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return clearRemnants();
}

/**
 * Remove a run scratch directory — marked or receipted — while keeping its
 * retry evidence (the ownership marker and the quarantine receipt) until
 * every other entry is gone. The whole removal is anchored to directory fds:
 * the guard files are unlinked and restored through the verified directory
 * itself, never through a path a swap could redirect, and the final rmdir
 * targets the proven entry inside a parent fd held open. Platforms without
 * `/proc/self/fd` first rename the verified directory to a fresh quarantine
 * sibling (a name the sweep still recognizes: the segment prefix is
 * preserved) and complete the evidence-preserving removal there.
 * An interrupted removal (mount point, concurrent writer, unstable tree)
 * leaves a still-evidenced directory a later retry can act on, instead of an
 * unrecoverable unmarked orphan.
 */
async function removeMarkedRunScratchDir(
  dir: string,
  marker: HeartbeatRunScratchMetadata | null,
  walkerOps?: RunScratchWalkerOpsOverride,
): Promise<{ complete: boolean; cause?: "blocked" | "unstable" }> {
  const ops = resolveWalkerOps(walkerOps);
  // Base name the tree's retry evidence refers to: the original segment,
  // without any quarantine suffix a retry may already be operating under.
  const evidenceBase = path.basename(path.resolve(dir)).replace(QUARANTINE_NAME_RE, "");
  let target = dir;
  if ((await ops.resolveAnchoring()) !== "procfd") {
    // Portable platforms never delete through the original name: quarantine
    // first (fail-closed on any identity surprise), then complete the same
    // evidence-preserving removal inside the quarantine path.
    const quarantine = await quarantineRenameForPortableRemoval(
      dir,
      ops,
      marker
        ? {
            version: 1,
            kind: "scratch",
            companyId: marker.companyId,
            agentId: marker.agentId,
            runId: marker.runId,
            originalName: evidenceBase,
            createdAt: new Date().toISOString(),
          }
        : {
            version: 1,
            kind: "home",
            companyId: null,
            agentId: null,
            runId: null,
            originalName: evidenceBase,
            createdAt: new Date().toISOString(),
          },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { kind: "missing" } as const;
      throw error;
    });
    if (quarantine.kind === "missing") return { complete: true };
    if (quarantine.kind === "refused") return { complete: false, cause: "unstable" };
    target = quarantine.path;
  }
  let verified: VerifiedDir | null = null;
  try {
    verified = await openVerifiedDirectory(target, ops);
    if (!verified) return { complete: false, cause: "unstable" };
    const walk = await removeEntriesWithinDevice(
      verified.fd,
      verified.identity.dev,
      ops,
      new Set([HEARTBEAT_RUN_SCRATCH_MARKER, RUN_SCRATCH_QUARANTINE_RECEIPT]),
    );
    if (!walk.complete) return { complete: false, cause: walk.unstable ? "unstable" : "blocked" };
    // Retire the retry evidence only once every other entry is gone, guard
    // files first: the receipt already lost its job the moment the removal
    // got this far, while the marker is the last name standing between an
    // interrupted rmdir and an unrecoverable unmarked orphan.
    const receiptCleared = await ops.unlinkEntry(verified.fd, RUN_SCRATCH_QUARANTINE_RECEIPT).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    );
    if (!receiptCleared) return { complete: false, cause: "blocked" };
    const markerFailed = await ops.unlinkEntry(verified.fd, HEARTBEAT_RUN_SCRATCH_MARKER).then(
      () => false,
      (error: NodeJS.ErrnoException) => marker !== null && error.code !== "ENOENT",
    );
    if (markerFailed) return { complete: false, cause: "blocked" };
    let removed: "removed" | "missing" | "kept" | "unstable";
    try {
      removed = await removeDirNameViaParent(target, verified.identity, ops);
    } catch (error) {
      await restoreGuardFilesThroughFd(ops, verified.fd, marker, evidenceBase);
      throw error;
    }
    if (removed === "removed" || removed === "missing") {
      // The name is gone from its parent, but only a dead inode proves the
      // directory itself was deleted: a concurrent rename leaves the emptied
      // original — now unmarked — alive wherever it moved to. Fail closed
      // unless the directory held open is really unreferenced, and put the
      // evidence back into that same inode.
      const stillLinked = await ops
        .statDir(verified.fd)
        .then((identity) => identity.nlink > 0)
        .catch(() => true);
      if (!stillLinked) return { complete: true };
      await restoreGuardFilesThroughFd(ops, verified.fd, marker, evidenceBase);
      return { complete: false, cause: "unstable" };
    }
    // The emptied directory could not be removed by name (a concurrent
    // writer refilled it, or the name was swapped after the walk): restore
    // the evidence through the anchored fd — the original directory, wherever
    // it now lives, keeps the ownership evidence a later retry needs.
    await restoreGuardFilesThroughFd(ops, verified.fd, marker, evidenceBase);
    return { complete: false, cause: removed === "kept" ? "blocked" : "unstable" };
  } finally {
    if (verified) await ops.closeDir(verified.fd).catch(() => undefined);
  }
}

async function restoreGuardFilesThroughFd(
  ops: RunScratchWalkerOps,
  fd: number,
  marker: HeartbeatRunScratchMetadata | null,
  evidenceBase: string,
): Promise<void> {
  // Exclusive creation (O_CREAT|O_EXCL) through the anchored entry name: a
  // name that concurrently reappeared — a regular file or a symlink — is
  // neither followed nor truncated, so the restore can never write outside
  // the verified directory. A concurrent writer that recreated the name
  // keeps its copy; when the name is not free the directory simply stays as
  // it is. A refused anchor (the recorded path was redirected) also leaves
  // the directory untouched.
  if (marker) {
    await ops
      .writeEntryExclusive(fd, HEARTBEAT_RUN_SCRATCH_MARKER, `${JSON.stringify(marker, null, 2)}\n`, 0o600)
      .catch(() => undefined);
  }
  await ops
    .writeEntryExclusive(
      fd,
      RUN_SCRATCH_QUARANTINE_RECEIPT,
      `${JSON.stringify({
        version: 1,
        kind: marker ? "scratch" : "home",
        companyId: marker?.companyId ?? null,
        agentId: marker?.agentId ?? null,
        runId: marker?.runId ?? null,
        originalName: evidenceBase,
        createdAt: new Date().toISOString(),
      } as RunScratchQuarantineReceipt, null, 2)}\n`,
      0o600,
    )
    .catch(() => undefined);
}

export async function cleanupHeartbeatRunScratch(input: {
  scratch: HeartbeatRunScratch;
  processGroupId?: number | null;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
  /** Persist recovery evidence after ownership/liveness checks, before removal. */
  beforeRemove?: () => Promise<void>;
  walkerOps?: RunScratchWalkerOpsOverride;
  runTempRootOverride?: string;
}): Promise<HeartbeatRunScratchCleanupResult> {
  const dir = path.resolve(input.scratch.dir);
  if (classifyRunScratchDir(dir, input.runTempRootOverride) === null) {
    return { removed: false, dir, reason: "unmarked" };
  }
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return { removed: false, dir, reason: "symlink" };
  } catch {
    // A portable removal that was interrupted after its quarantine rename
    // leaves the tree under `<segment>-rm-<random>` while this path stays
    // gone. The remnant is only continued when it still carries this run's
    // own evidence — its ownership marker or the quarantine receipt — and
    // the ownership, liveness and retention gates are re-evaluated on it:
    // the rename already happened, but it is never accepted as proof that
    // the gates passed.
    const remnants = await runScratchRemnantDirs(dir);
    if (remnants.length === 0) return { removed: false, dir, reason: "missing" };
    const metadata = input.scratch.metadata;
    for (const remnant of remnants) {
      if (await quarantineProtectionActive(remnant)) {
        return { removed: false, dir, reason: "ai_home_retained" };
      }
      const marker = await readMarker(path.join(remnant, HEARTBEAT_RUN_SCRATCH_MARKER)).catch(() => null);
      const receipt = marker
        ? null
        : await readQuarantineReceipt(path.join(remnant, RUN_SCRATCH_QUARANTINE_RECEIPT)).catch(() => null);
      const markerOurs = marker !== null &&
        marker.companyId === metadata.companyId &&
        marker.agentId === metadata.agentId &&
        marker.runId === metadata.runId;
      const receiptOurs = receipt !== null &&
        receipt.kind === "scratch" &&
        receipt.companyId === metadata.companyId &&
        receipt.agentId === metadata.agentId &&
        receipt.runId === metadata.runId &&
        receipt.originalName === path.basename(dir).replace(QUARANTINE_NAME_RE, "");
      if (!markerOurs && !receiptOurs) {
        return { removed: false, dir, reason: marker || receipt ? "owner_mismatch" : "unmarked" };
      }
      if (input.isProcessGroupAlive?.(input.processGroupId) === true) {
        return { removed: false, dir, reason: "process_group_alive" };
      }
      await input.beforeRemove?.();
      const cleared = await removeMarkedRunScratchDir(remnant, markerOurs ? marker : null, input.walkerOps)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return { complete: true } as const;
          return null;
        });
      if (cleared?.complete !== true) {
        return { removed: false, dir, reason: !cleared || cleared.cause === "unstable" ? "unsafe_tree" : "mount_point_present" };
      }
    }
    // Completion requires the remnants to be really gone, not just attempted.
    if ((await runScratchRemnantDirs(dir)).length > 0) {
      return { removed: false, dir, reason: "unsafe_tree" };
    }
    return { removed: true, dir };
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
  // A retained managed AI home inside this directory still holds a credential
  // the run could not write back; the directory survives until the retained
  // cleanup retires the home.
  if (await retainedAiCredentialCleanupHomeInside(dir)) {
    return { removed: false, dir, reason: "ai_home_retained" };
  }

  await input.beforeRemove?.();
  const removal = await removeMarkedRunScratchDir(dir, input.scratch.metadata, input.walkerOps);
  if (!removal.complete) {
    return { removed: false, dir, reason: removal.cause === "unstable" ? "unsafe_tree" : "mount_point_present" };
  }
  return { removed: true, dir };
}

/** "unknown" means this instance cannot establish ownership; it is never removed. */
export type RunScratchSweepRunState = "terminal" | "active" | "unknown";

export interface SweepRunScratchResult {
  scanned: number;
  removed: string[];
  kept: number;
  truncated: boolean;
  /**
   * Directories the sweep kept that still represent unfinished cleanup work
   * for this runner: terminal-run directories it could not remove yet
   * (process group still exiting, retained credential home, blocked or
   * unstable tree, truncation) and active runs' directories, whose reclamation
   * becomes due when the run settles. Directories of unknown (foreign)
   * ownership are never removed and do not count: another instance owns
   * their cleanup. Zero means the sweep has settled.
   */
  pending: number;
}

export const RUN_SCRATCH_SWEEP_MAX_SCAN = 500;
export const RUN_SCRATCH_SWEEP_MAX_REMOVE = 100;

// Instances with separate databases share the temp root, so a run absent from
// this instance's database may belong to another live instance. Keep those.
const sweepCursors = new Map<string, number>();

/**
 * Remove leftover run scratch directories whose owning run is terminal (or
 * whose run row is long gone). Earlier process attempts of a run that crossed
 * a restart leave directories that the live attempt's cleanup never sees.
 * Managed AI credential homes live inside the per-run directory, so this sweep
 * also retires those homes once their run is terminal.
 *
 * Safety: only real (non-symlink) directories directly under a root owned by
 * this runner — the per-run temp root, or the OS temp root with the historical
 * `paperclip-run-` prefix — with a valid regular-file marker, are considered.
 * Active runs and unmarked directories are always kept. A terminal run is
 * only removed after its process group is proven exited (`isRunProcessGroupAlive`)
 * and no retained credential home still depends on the directory. Work per
 * sweep is bounded.
 */
/**
 * Legacy roots live in the shared OS temp directory, where the run id in the
 * marker alone does not prove this runner created the tree or that no foreign
 * writer can act on it: only a directory owned by this process's user and
 * closed to group/other writes, carrying a marker owned by the same user and
 * not world-writable, may be removed.
 */
async function legacySweepCandidateIsSafelyOwned(
  dir: string,
  markerStat: { uid: number; mode: number },
): Promise<boolean> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  if (markerStat.uid !== uid || (markerStat.mode & 0o002) !== 0) return false;
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return stats.uid === uid && (stats.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/**
 * A quarantine remnant in the shared OS temp directory has no marker left to
 * check (the interrupted removal may already have unlinked it), so the
 * directory's own ownership and closed permissions are the evidence — the
 * same bar `legacySweepCandidateIsSafelyOwned` sets for the marker itself.
 */
async function legacyRemnantSafelyOwned(dir: string): Promise<boolean> {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid === null) return false;
  try {
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
    return stats.uid === uid && (stats.mode & 0o022) === 0 && (stats.mode & 0o002) === 0;
  } catch {
    return false;
  }
}

export async function sweepOrphanedRunScratch(input: {
  resolveRunStates: (runIds: string[]) => Promise<Map<string, RunScratchSweepRunState>>;
  /**
   * Answers whether the owning run's process group is still alive. `true`
   * keeps the directory even for a terminal run; `false` or `undefined`
   * (no group id known to the caller) allows removal.
   */
  isRunProcessGroupAlive?: (runId: string) => boolean | undefined;
  /** Restrict the sweep to one run's directories (used when that run ends). */
  runId?: string;
  /** Overrides the legacy OS temp root (tests). */
  tmpRoot?: string;
  /** Overrides the per-run temp root (tests). */
  runTempRootOverride?: string;
  /** Overrides the operations used by the removal walk (tests). */
  walkerOps?: RunScratchWalkerOpsOverride;
  maxScan?: number;
  maxRemove?: number;
}): Promise<SweepRunScratchResult> {
  const legacyRoot = path.resolve(input.tmpRoot ?? os.tmpdir());
  const tempRoot = path.resolve(input.runTempRootOverride ?? runTempRoot());
  const maxScan = input.maxScan ?? RUN_SCRATCH_SWEEP_MAX_SCAN;
  const maxRemove = input.maxRemove ?? RUN_SCRATCH_SWEEP_MAX_REMOVE;
  const result: SweepRunScratchResult = { scanned: 0, removed: [], kept: 0, truncated: false, pending: 0 };

  const runNeedle = input.runId !== undefined ? `-${sanitizePathSegment(input.runId.slice(0, 12), "run")}-` : null;
  const tempSegment = input.runId !== undefined ? runTempSegment(input.runId) : null;

  const roots: Array<{ root: string; legacy: boolean }> = [];
  if (legacyRoot !== tempRoot) roots.push({ root: legacyRoot, legacy: true });
  roots.push({ root: tempRoot, legacy: false });

  const candidates: Array<{ dir: string; marker: HeartbeatRunScratchMetadata }> = [];
  // Quarantine remnants of interrupted portable removals: the original name
  // is gone and the marker may already have been unlinked, but the tree
  // still holds the run's leftover files. Their removal only ever follows a
  // quarantine rename that had already passed the ownership and liveness
  // gates, so the name pattern (within a root this runner owns) plus the
  // legacy ownership checks are the remaining evidence.
  const remnantCandidates: string[] = [];
  for (const { root, legacy } of roots) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const named = entries
      .filter((entry) =>
        entry.isDirectory() && !entry.isSymbolicLink() &&
        (!legacy ||
          entry.name.startsWith("paperclip-run-") ||
          (runNeedle === null && entry.name.startsWith("paperclip-ai-") && QUARANTINE_NAME_RE.test(entry.name))) &&
        (legacy
          ? runNeedle === null || entry.name.includes(runNeedle)
          : tempSegment === null || entry.name === tempSegment || entry.name.startsWith(`${tempSegment}-`))
      )
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    if (named.length === 0) continue;

    // Each root gets its own bounded budget, so a crowded legacy temp root
    // cannot starve the per-run temp root of its scan window.
    let rootScanned = 0;
    let rootTruncated = false;
    // A global sweep rotates its start so entries that are always kept cannot
    // starve later ones. A per-run sweep pre-filtered by name starts at zero.
    const start = runNeedle === null && named.length > 0 ? (sweepCursors.get(root) ?? 0) % named.length : 0;
    for (let i = 0; i < named.length; i += 1) {
      const entry = named[(start + i) % named.length]!;
      if (runNeedle === null && rootScanned >= maxScan) {
        rootTruncated = true;
        sweepCursors.set(root, start + i);
        break;
      }
      rootScanned += 1;
      const dir = path.join(root, entry.name);
      const isRemnant = QUARANTINE_NAME_RE.test(entry.name);
      try {
        const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
        const markerStat = await fs.lstat(markerPath).catch(() => null);
        if (markerStat?.isFile()) {
          const marker = await readMarker(markerPath);
          if (!marker) {
            // A present but unreadable marker is no evidence this runner can
            // act on: the directory stays untouched.
            result.kept += 1;
            continue;
          }
          if (input.runId !== undefined && marker.runId !== input.runId) {
            // A per-run sweep only acts on its own run's evidence; another
            // run's remnant is not a name-shape authorization to remove it.
            result.kept += 1;
            continue;
          }
          if (legacy && !(await legacySweepCandidateIsSafelyOwned(dir, markerStat))) {
            result.kept += 1;
            continue;
          }
          candidates.push({ dir, marker });
          continue;
        }
        // A quarantine remnant whose marker was already unlinked (or never
        // re-created after a late-stage interruption) may still be the
        // unfinished tail of this runner's own gated removal — but only the
        // quarantine receipt can prove that; the name alone never does.
        if (isRemnant && (!legacy || await legacyRemnantSafelyOwned(dir))) remnantCandidates.push(dir);
        else result.kept += 1;
      } catch {
        result.kept += 1;
      }
    }
    result.scanned += rootScanned;
    result.truncated = result.truncated || rootTruncated;
    if (runNeedle === null && !rootTruncated) sweepCursors.set(root, 0);
  }

  const states = candidates.length
    ? await input.resolveRunStates([...new Set(candidates.map((c) => c.marker.runId))])
    : new Map<string, RunScratchSweepRunState>();
  for (const { dir, marker } of candidates) {
    const state = states.get(marker.runId) ?? "active";
    const removable = state === "terminal" && input.isRunProcessGroupAlive?.(marker.runId) !== true &&
      !(await retainedAiCredentialCleanupHomeInside(dir));
    if (!removable || result.removed.length >= maxRemove) {
      if (removable) result.truncated = true;
      result.kept += 1;
      // Terminal-run directories stay this sweep's unfinished cleanup;
      // active-run directories are a future obligation that becomes
      // removable once the run settles. Unknown ownership is not ours.
      if (removable || state === "terminal" || state === "active") result.pending += 1;
      continue;
    }
    try {
      // Re-check just before removal: never remove through a swapped symlink.
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        result.kept += 1;
        continue;
      }
      const removal = await removeMarkedRunScratchDir(dir, marker, input.walkerOps);
      if (!removal.complete) {
        result.kept += 1;
        // A terminal-run removal that could not finish retries on a later sweep.
        result.pending += 1;
        continue;
      }
      result.removed.push(dir);
    } catch {
      result.kept += 1;
      result.pending += 1;
    }
  }
  // Quarantine remnants are only reclaimed with verifiable evidence of a
  // gated cleanup this runner started: the receipt the quarantining removal
  // wrote through the verified directory before its rename. From the receipt
  // the same protections as any marked directory are re-derived — run state,
  // process-group liveness, retained credential homes — so a foreign or
  // forged `-rm-` name never substitutes for the gates having passed.
  const remnantEvidence: Array<{ dir: string; receipt: RunScratchQuarantineReceipt }> = [];
  for (const dir of remnantCandidates) {
    const base = path.basename(dir).replace(QUARANTINE_NAME_RE, "");
    const receipt = await readQuarantineReceipt(path.join(dir, RUN_SCRATCH_QUARANTINE_RECEIPT)).catch(() => null);
    if (receipt && receipt.originalName === base) {
      remnantEvidence.push({ dir, receipt });
    } else {
      // No verifiable evidence: not this sweep's tree to destroy.
      result.kept += 1;
    }
  }
  const remnantStates = remnantEvidence.some((e) => e.receipt.kind === "scratch" && e.receipt.runId)
    ? await input.resolveRunStates([
        ...new Set(
          remnantEvidence
            .filter((e) => e.receipt.kind === "scratch" && e.receipt.runId)
            .map((e) => e.receipt.runId!),
        ),
      ])
    : new Map<string, RunScratchSweepRunState>();
  for (const { dir, receipt } of remnantEvidence) {
    const runId = receipt.kind === "scratch" ? receipt.runId : null;
    if (runId) {
      const state = remnantStates.get(runId) ?? "active";
      const removable = state === "terminal" && input.isRunProcessGroupAlive?.(runId) !== true &&
        !(await quarantineProtectionActive(dir));
      if (!removable) {
        result.kept += 1;
        if (state === "terminal" || state === "active") result.pending += 1;
        continue;
      }
    } else if (await quarantineProtectionActive(dir)) {
      // Home remnants carry no run to interrogate: the teardown hold is the
      // protection that survives the rename — also when it is still
      // registered under the pre-quarantine name.
      result.kept += 1;
      result.pending += 1;
      continue;
    }
    if (result.removed.length >= maxRemove) {
      result.truncated = true;
      result.kept += 1;
      result.pending += 1;
      continue;
    }
    try {
      // Re-check just before removal: never remove through a swapped symlink.
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        result.kept += 1;
        continue;
      }
      const removal = await removeMarkedRunScratchDir(dir, null, input.walkerOps)
        .catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? { complete: true } : null));
      if (!removal?.complete) {
        result.kept += 1;
        result.pending += 1;
        continue;
      }
      result.removed.push(dir);
    } catch {
      result.kept += 1;
      result.pending += 1;
    }
  }
  return result;
}
