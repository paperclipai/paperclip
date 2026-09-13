import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  HEARTBEAT_RUN_SCRATCH_MARKER,
  readHeartbeatRunScratchMarker,
} from "./run-scratch.js";

// Terminal statuses mirror heartbeat's HEARTBEAT_RUN_TERMINAL_STATUSES. Kept
// local so this sweeper does not have to import the (very large) heartbeat
// service module; a drift here at worst delays scratch removal by one sweep.
const TERMINAL_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);

export const RUN_SCRATCH_DIR_PREFIX = "paperclip-run-";
export const DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;
export const RUN_SCRATCH_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface OrphanedRunScratchSweepResult {
  scanned: number;
  removed: number;
  removedDirs: string[];
  skippedLiveRun: number;
  skippedTooYoung: number;
  skippedUnreadable: number;
  failed: Array<{ dir: string; error: string }>;
}

export type LoadHeartbeatRunStatus = (
  runId: string,
) => Promise<{ status: string | null } | null>;

export interface SweepOrphanedRunScratchDirsInput {
  db?: Db;
  now?: Date;
  /** Grace period before a run-owned scratch dir is eligible for removal. */
  minAgeMs?: number;
  /** Scan root; defaults to os.tmpdir(). Injectable for tests. */
  tmpRoot?: string;
  /** Injectable run-status loader; defaults to a heartbeatRuns lookup. */
  loadRun?: LoadHeartbeatRunStatus;
}

/**
 * Best-effort recursive chmod before removal. Run scratch dirs can contain
 * read-only files created by go module caches (and similar tool caches), which
 * make a plain `fs.rm` fail with EACCES/EPERM. Ops previously had to chmod -R
 * by hand before deleting leaked dirs; do the same in-process so removal
 * succeeds without manual intervention. Failures here are non-fatal: the
 * removal attempt below still runs and reports its own error if it fails.
 */
async function chmodRecursiveForRemoval(dir: string): Promise<void> {
  const chmodOne = async (entryPath: string, isDirectory: boolean) => {
    await fs
      .chmod(entryPath, isDirectory ? 0o700 : 0o600)
      .catch(() => undefined);
  };
  await chmodOne(dir, true);
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let children: Dirent[];
    try {
      children = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of children) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await chmodOne(entryPath, true);
        stack.push(entryPath);
      } else if (entry.isFile()) {
        await chmodOne(entryPath, false);
      }
    }
  }
}

/**
 * Remove orphaned `paperclip-run-*` scratch directories that leaked because the
 * heartbeat execution `finally` never ran (server restart/crash mid-run) or a
 * cleanup skip reason was never retried. A dir is removed when:
 *   - it carries a valid run-scratch marker,
 *   - it is older than the grace period, and
 *   - its runId is terminal or no longer exists in the database.
 * Dirs whose run is still queued/running are live and left alone; the next
 * sweep (or the run's own finally) cleans them up.
 */
export async function sweepOrphanedRunScratchDirs(
  input: SweepOrphanedRunScratchDirsInput = {},
): Promise<OrphanedRunScratchSweepResult> {
  const now = input.now ?? new Date();
  const minAgeMs = input.minAgeMs ?? DEFAULT_RUN_SCRATCH_SWEEP_MIN_AGE_MS;
  const tmpRoot = path.resolve(input.tmpRoot ?? os.tmpdir());
  const db = input.db;
  const loadRun: LoadHeartbeatRunStatus | null =
    input.loadRun ??
    (db
      ? async (runId) => {
          const rows = await db
            .select({ status: heartbeatRuns.status })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, runId))
            .limit(1);
          return rows[0] ?? null;
        }
      : null);

  const result: OrphanedRunScratchSweepResult = {
    scanned: 0,
    removed: 0,
    removedDirs: [],
    skippedLiveRun: 0,
    skippedTooYoung: 0,
    skippedUnreadable: 0,
    failed: [],
  };

  let entries: Dirent[];
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  } catch (err) {
    logger.warn(
      { err, tmpRoot },
      "run scratch sweeper could not list tmpdir; skipping sweep",
    );
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(RUN_SCRATCH_DIR_PREFIX)) continue;
    const dir = path.join(tmpRoot, entry.name);
    result.scanned += 1;

    const marker = await readHeartbeatRunScratchMarker(
      path.join(dir, HEARTBEAT_RUN_SCRATCH_MARKER),
    );
    if (!marker) {
      // No valid marker: not ours to judge (may belong to an in-flight run
      // that has not written its marker yet, or foreign content). Leave it.
      continue;
    }

    // Age check uses the marker timestamp and falls back to the dir mtime.
    let ageMs: number | null = null;
    const createdAtMs = Date.parse(marker.createdAt);
    if (Number.isFinite(createdAtMs)) {
      ageMs = now.getTime() - createdAtMs;
    } else {
      try {
        const stats = await fs.stat(dir);
        ageMs = now.getTime() - stats.mtimeMs;
      } catch {
        ageMs = null;
      }
    }
    if (ageMs === null || ageMs < minAgeMs) {
      result.skippedTooYoung += 1;
      continue;
    }

    if (!loadRun) {
      result.skippedUnreadable += 1;
      continue;
    }

    let runStatus: string | null | undefined;
    try {
      const run = await loadRun(marker.runId);
      runStatus = run?.status ?? null;
    } catch (err) {
      logger.warn(
        { err, dir, runId: marker.runId },
        "run scratch sweeper failed to load run status; skipping dir",
      );
      result.skippedUnreadable += 1;
      continue;
    }
    if (runStatus != null && !TERMINAL_RUN_STATUSES.has(runStatus)) {
      result.skippedLiveRun += 1;
      continue;
    }

    await chmodRecursiveForRemoval(dir);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      result.removed += 1;
      result.removedDirs.push(dir);
    } catch (err) {
      result.failed.push({
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export interface RunScratchSweeperHandle {
  /** Runs one sweep immediately and returns its result. */
  sweepOnce(): Promise<OrphanedRunScratchSweepResult>;
  stop(): void;
}

/**
 * Periodic orphan scratch sweeper. Runs one sweep after `startupDelayMs`
 * (default 1 min, so startup run recovery has settled) and then on a fixed
 * interval (default 6h). The interval timer is unref'd so it never keeps the
 * process alive on its own; callers should still stop() it on shutdown.
 */
export function startRunScratchSweeper(input: {
  db: Db;
  intervalMs?: number;
  startupDelayMs?: number;
  minAgeMs?: number;
  /** Test overrides, forwarded to sweepOrphanedRunScratchDirs. */
  tmpRoot?: string;
  loadRun?: LoadHeartbeatRunStatus;
}): RunScratchSweeperHandle {
  const intervalMs = input.intervalMs ?? RUN_SCRATCH_SWEEP_INTERVAL_MS;
  const startupDelayMs = input.startupDelayMs ?? 60 * 1000;
  let sweeping = false;
  let stopped = false;

  const logSweepResult = (result: OrphanedRunScratchSweepResult) => {
    if (result.removed > 0 || result.failed.length > 0) {
      logger.info(
        {
          scanned: result.scanned,
          removed: result.removed,
          removedDirs: result.removedDirs,
          skippedLiveRun: result.skippedLiveRun,
          skippedTooYoung: result.skippedTooYoung,
          failed: result.failed,
        },
        "orphaned run scratch sweep removed leaked scratch directories",
      );
    }
  };

  const runOnce = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const result = await sweepOrphanedRunScratchDirs({
        db: input.db,
        minAgeMs: input.minAgeMs,
        tmpRoot: input.tmpRoot,
        loadRun: input.loadRun,
      });
      logSweepResult(result);
      return result;
    } catch (err) {
      logger.error({ err }, "orphaned run scratch sweep failed");
      return undefined;
    } finally {
      sweeping = false;
    }
  };

  const startupTimer = setTimeout(() => {
    void runOnce();
  }, startupDelayMs);
  startupTimer.unref?.();

  const intervalTimer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  intervalTimer.unref?.();

  return {
    sweepOnce: async () => {
      const result = await runOnce();
      if (!result) throw new Error("run scratch sweep already in progress");
      return result;
    },
    stop: () => {
      clearTimeout(startupTimer);
      clearInterval(intervalTimer);
    },
  };
}