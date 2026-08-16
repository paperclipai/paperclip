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
  | { removed: false; dir: string; reason: "missing" | "unmarked" | "owner_mismatch" | "process_alive" };

export interface HeartbeatRunScratchReconciliationResult {
  processGroupAlive: boolean;
  removedDirs: string[];
  remainingDirs: string[];
}

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

export async function listHeartbeatRunScratch(): Promise<HeartbeatRunScratch[]> {
  const tmpRoot = path.resolve(os.tmpdir());
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  const scratch: HeartbeatRunScratch[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("paperclip-run-")) continue;
    const dir = path.join(tmpRoot, entry.name);
    const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
    const metadata = await readMarker(markerPath);
    if (!metadata) continue;
    scratch.push({ dir, markerPath, metadata });
  }
  return scratch;
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
  processPid?: number | null;
  processGroupId?: number | null;
  isPidAlive?: (pid: number) => boolean;
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
  if (
    (typeof input.processPid === "number" && input.isPidAlive?.(input.processPid) === true) ||
    input.isProcessGroupAlive?.(input.processGroupId) === true
  ) {
    return { removed: false, dir, reason: "process_alive" };
  }

  await fs.rm(dir, { recursive: true, force: true });
  return { removed: true, dir };
}

export async function reconcileHeartbeatRunScratch(input: {
  companyId: string;
  agentId: string;
  runId: string;
  processPid?: number | null;
  processGroupId?: number | null;
  isPidAlive?: (pid: number) => boolean;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
}): Promise<HeartbeatRunScratchReconciliationResult> {
  if (
    (typeof input.processPid === "number" && input.isPidAlive?.(input.processPid) === true) ||
    input.isProcessGroupAlive?.(input.processGroupId) === true
  ) {
    return { processGroupAlive: true, removedDirs: [], remainingDirs: [] };
  }

  const tmpRoot = path.resolve(os.tmpdir());
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  const removedDirs: string[] = [];
  const remainingDirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("paperclip-run-")) continue;
    const dir = path.join(tmpRoot, entry.name);
    const markerPath = path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER);
    const metadata = await readMarker(markerPath);
    if (!metadata) {
      const runSegment = sanitizePathSegment(input.runId.slice(0, 12), "run");
      if (entry.name.includes(`-${runSegment}-`)) remainingDirs.push(dir);
      continue;
    }
    if (
      metadata.companyId !== input.companyId ||
      metadata.agentId !== input.agentId ||
      metadata.runId !== input.runId
    ) {
      continue;
    }
    const result = await cleanupHeartbeatRunScratch({
      scratch: { dir, markerPath, metadata },
      processPid: input.processPid,
      processGroupId: input.processGroupId,
      isPidAlive: input.isPidAlive,
      isProcessGroupAlive: input.isProcessGroupAlive,
    });
    if (result.removed || result.reason === "missing") removedDirs.push(dir);
    else remainingDirs.push(dir);
  }

  return { processGroupAlive: false, removedDirs, remainingDirs };
}
