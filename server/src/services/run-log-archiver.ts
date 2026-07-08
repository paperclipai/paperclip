import { promises as fs } from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { createDb, heartbeatRuns } from "@paperclipai/db";
import type { Config } from "../config.js";
import { logger } from "../middleware/logger.js";
import {
  prepareRunLogArchiveSource,
  resolveRunLogBasePath,
  type RunLogArchiveSource,
} from "./run-log-store.js";
import { getStorageProvider } from "../storage/index.js";

/**
 * Run-log cold-archive sweeper.
 *
 * Steps 1+2 gave us compress-on-complete (~88x) + a per-run size cap. Step 3
 * closes the lifecycle: keep the (now tiny) compressed logs hot for
 * `hotRetentionDays`, then move older *terminal* runs to object storage keyed
 * `run-logs/<companyId>/<agentId>/<runId>.ndjson.gz`, verify the upload, flip
 * the DB tier pointer to `s3`, and delete the hot copy. A per-company fairness
 * budget archives a noisy tenant's oldest terminal runs early so one company
 * cannot starve the shared volume between age sweeps.
 *
 * The sweeper is dependency-injected so it can be exercised against fakes; the
 * production wiring (`createRunLogArchiverFromRuntime`) binds it to Drizzle, the
 * storage provider, and the on-disk run-log tree.
 */

const TERMINAL_STATUSES = ["succeeded", "failed", "timed_out", "cancelled"] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GZIP_CONTENT_TYPE = "application/gzip";

/** A heartbeat run row projected down to just what the archiver reasons about. */
export interface HeartbeatRunLogRow {
  id: string;
  companyId: string;
  agentId: string;
  status: string;
  finishedAt: Date | null;
  logStore: string | null;
  logRef: string | null;
}

/** DB port: only terminal, still-local runs are ever returned. */
export interface RunLogArchiverDb {
  /** Terminal `local_file` runs whose completion time is older than `cutoff`, oldest first. */
  selectAgeArchivable(cutoff: Date, limit: number): Promise<HeartbeatRunLogRow[]>;
  /** Terminal `local_file` runs for one company, oldest first (ignores the age gate). */
  selectCompanyArchivableOldestFirst(companyId: string, limit: number): Promise<HeartbeatRunLogRow[]>;
  /** Flip a run's tier pointer to `s3` and repoint its logRef at the object key. */
  markArchivedToS3(runId: string, objectKey: string, now: Date): Promise<void>;
}

/** Object-storage port (raw provider, system-scoped keys — not company-prefixed). */
export interface RunLogArchiverStorage {
  putObject(input: {
    objectKey: string;
    body: Buffer;
    contentType: string;
    contentLength: number;
  }): Promise<void>;
  headObject(input: { objectKey: string }): Promise<{ exists: boolean; contentLength?: number }>;
}

/** Filesystem port over the on-disk run-log tree. */
export interface RunLogArchiverFs {
  /** Resolve + ensure-gzipped the local file for a logRef, ready to upload. */
  prepareArchiveSource(logRef: string): Promise<RunLogArchiveSource>;
  readFileBuffer(absPath: string): Promise<Buffer>;
  /** Unlink an uploaded file and prune now-empty agent/company dirs (best-effort). */
  removeArchivedFile(absPath: string): Promise<void>;
  /** Sum on-disk (compressed) run-log bytes per companyId by walking the base dir. */
  computeCompanyHotBytes(): Promise<Map<string, number>>;
}

export interface RunLogArchiverConfig {
  mode: "auto" | "off";
  /** True when object storage is actually configured (storageProvider === "s3"). */
  storageEnabled: boolean;
  hotRetentionDays: number;
  companyBudgetBytes: number;
  /** Max archive actions attempted per sweep (fairness + age combined). */
  itemLimit: number;
}

export interface RunLogArchiverDeps {
  db: RunLogArchiverDb;
  storage: RunLogArchiverStorage;
  files: RunLogArchiverFs;
  config: RunLogArchiverConfig;
  now: () => Date;
  log?: Pick<typeof logger, "info" | "warn" | "error">;
}

export interface RunLogSweepResult {
  skipped: boolean;
  reason?: "mode_off" | "storage_unavailable";
  examined: number;
  ageArchived: number;
  fairnessArchived: number;
  failed: number;
}

export interface RunLogArchiver {
  runSweep(): Promise<RunLogSweepResult>;
}

export function resolveRunLogArchiverConfig(config: Config): RunLogArchiverConfig {
  return {
    mode: config.runLogArchiveMode,
    storageEnabled: config.storageProvider === "s3",
    hotRetentionDays: config.runLogHotRetentionDays,
    companyBudgetBytes: config.runLogCompanyBudgetBytes,
    itemLimit: config.runLogSweepItemLimit,
  };
}

export function createRunLogArchiver(deps: RunLogArchiverDeps): RunLogArchiver {
  const log = deps.log ?? logger;

  /**
   * Archive a single run end-to-end: gzip-if-needed → upload → head-verify →
   * flip DB tier → delete local. Returns the freed (compressed) byte count, or
   * 0 if it was skipped/failed. NEVER throws: a single run must not abort the
   * sweep; a failed run stays `local_file` and is retried next sweep.
   */
  async function archiveOne(row: HeartbeatRunLogRow): Promise<number> {
    if (!row.logRef) return 0;

    let source: RunLogArchiveSource;
    try {
      source = await deps.files.prepareArchiveSource(row.logRef);
    } catch (err) {
      log.warn(
        { err, runId: row.id, logRef: row.logRef },
        "run-log archive: local file missing/unresolvable; skipping",
      );
      return 0;
    }

    try {
      const body = await deps.files.readFileBuffer(source.absPath);
      await deps.storage.putObject({
        objectKey: source.objectKey,
        body,
        contentType: GZIP_CONTENT_TYPE,
        contentLength: source.bytes,
      });

      // Verify-before-delete: only trust the upload once HEAD confirms the
      // object exists AND its size matches the local gz byte-for-byte.
      const head = await deps.storage.headObject({ objectKey: source.objectKey });
      if (!head.exists || head.contentLength !== source.bytes) {
        log.warn(
          {
            runId: row.id,
            objectKey: source.objectKey,
            expectedBytes: source.bytes,
            headBytes: head.contentLength,
            headExists: head.exists,
          },
          "run-log archive: upload verification failed; keeping local copy",
        );
        return 0;
      }

      await deps.db.markArchivedToS3(row.id, source.objectKey, deps.now());
      await deps.files.removeArchivedFile(source.absPath);
      log.info(
        { runId: row.id, companyId: row.companyId, objectKey: source.objectKey, bytes: source.bytes },
        "run-log archived to cold storage",
      );
      return source.bytes;
    } catch (err) {
      log.warn(
        { err, runId: row.id, logRef: row.logRef },
        "run-log archive: upload/flip failed; keeping local copy, will retry next sweep",
      );
      return 0;
    }
  }

  async function runSweep(): Promise<RunLogSweepResult> {
    const result: RunLogSweepResult = {
      skipped: false,
      examined: 0,
      ageArchived: 0,
      fairnessArchived: 0,
      failed: 0,
    };

    if (deps.config.mode === "off" || !deps.config.storageEnabled) {
      const reason = deps.config.mode === "off" ? "mode_off" : "storage_unavailable";
      result.skipped = true;
      result.reason = reason;
      log.info(
        { mode: deps.config.mode, storageEnabled: deps.config.storageEnabled, reason },
        "run-log archiver: archiving disabled; no-op sweep (hot files age out via infra janitor backstop)",
      );
      return result;
    }

    // Budget of archive actions for this whole sweep, shared across both passes.
    let budget = deps.config.itemLimit;

    // ---- Fairness pass: over-budget companies first, ignoring the age gate. ----
    try {
      const companyBytes = await deps.files.computeCompanyHotBytes();
      for (const [companyId, initialBytes] of companyBytes) {
        if (budget <= 0) break;
        if (initialBytes <= deps.config.companyBudgetBytes) continue;

        let bytes = initialBytes;
        const rows = await deps.db.selectCompanyArchivableOldestFirst(companyId, budget);
        for (const row of rows) {
          if (bytes <= deps.config.companyBudgetBytes || budget <= 0) break;
          result.examined += 1;
          budget -= 1;
          const freed = await archiveOne(row);
          if (freed > 0) {
            bytes -= freed;
            result.fairnessArchived += 1;
          } else {
            result.failed += 1;
          }
        }
      }
    } catch (err) {
      log.error({ err }, "run-log archiver: fairness pass failed");
    }

    // ---- Age pass: terminal runs older than the hot-retention window. ----
    try {
      if (budget > 0) {
        const cutoff = new Date(deps.now().getTime() - deps.config.hotRetentionDays * MS_PER_DAY);
        const rows = await deps.db.selectAgeArchivable(cutoff, budget);
        for (const row of rows) {
          if (budget <= 0) break;
          result.examined += 1;
          budget -= 1;
          const freed = await archiveOne(row);
          if (freed > 0) result.ageArchived += 1;
          else result.failed += 1;
        }
      }
    } catch (err) {
      log.error({ err }, "run-log archiver: age pass failed");
    }

    if (result.ageArchived > 0 || result.fairnessArchived > 0 || result.failed > 0) {
      log.info(
        { ...result },
        "run-log archiver sweep complete",
      );
    }
    return result;
  }

  return { runSweep };
}

// ---------------------------------------------------------------------------
// Production adapters
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof createDb>;

/** Drizzle-backed DB port. Only ever selects terminal, `local_file` runs. */
export function createDrizzleRunLogArchiverDb(db: Db): RunLogArchiverDb {
  const columns = {
    id: heartbeatRuns.id,
    companyId: heartbeatRuns.companyId,
    agentId: heartbeatRuns.agentId,
    status: heartbeatRuns.status,
    finishedAt: heartbeatRuns.finishedAt,
    logStore: heartbeatRuns.logStore,
    logRef: heartbeatRuns.logRef,
  } as const;

  // Completion time: finishedAt is set when a run reaches a terminal status, so
  // it is the authoritative "how old is this run" signal. Fall back to
  // updatedAt only if finishedAt is somehow null on a terminal row.
  const completedAt = sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.updatedAt})`;

  return {
    selectAgeArchivable(cutoff, limit) {
      return db
        .select(columns)
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.logStore, "local_file"),
            isNotNull(heartbeatRuns.logRef),
            inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
            sql`${completedAt} < ${cutoff}`,
          ),
        )
        .orderBy(asc(completedAt))
        .limit(limit);
    },

    selectCompanyArchivableOldestFirst(companyId, limit) {
      return db
        .select(columns)
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            eq(heartbeatRuns.logStore, "local_file"),
            isNotNull(heartbeatRuns.logRef),
            inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
          ),
        )
        .orderBy(asc(completedAt))
        .limit(limit);
    },

    async markArchivedToS3(runId, objectKey, now) {
      await db
        .update(heartbeatRuns)
        .set({ logStore: "s3", logRef: objectKey, updatedAt: now })
        .where(eq(heartbeatRuns.id, runId));
    },
  };
}

/** Filesystem port over the real run-log tree at `baseDir`. */
export function createNodeRunLogArchiverFs(baseDir: string): RunLogArchiverFs {
  async function pruneEmptyParents(absPath: string): Promise<void> {
    // Walk up (agent dir, then company dir), rmdir while empty, never past baseDir.
    let dir = path.dirname(absPath);
    const stop = path.resolve(baseDir);
    while (path.resolve(dir) !== stop && path.resolve(dir).startsWith(stop + path.sep)) {
      try {
        await fs.rmdir(dir);
      } catch {
        // Non-empty or already gone: stop climbing.
        break;
      }
      dir = path.dirname(dir);
    }
  }

  return {
    prepareArchiveSource: (logRef) => prepareRunLogArchiveSource(baseDir, logRef),
    readFileBuffer: (absPath) => fs.readFile(absPath),

    async removeArchivedFile(absPath) {
      await fs.unlink(absPath).catch(() => undefined);
      // If we archived a legacy raw file, the compressed sibling was created in
      // place — try to drop a stray raw sibling too.
      if (absPath.endsWith(".gz")) {
        await fs.unlink(absPath.slice(0, -".gz".length)).catch(() => undefined);
      }
      await pruneEmptyParents(absPath);
    },

    async computeCompanyHotBytes() {
      const totals = new Map<string, number>();
      const companyDirs = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => []);
      for (const companyEntry of companyDirs) {
        if (!companyEntry.isDirectory()) continue;
        const companyId = companyEntry.name;
        const companyDir = path.join(baseDir, companyId);
        let sum = 0;
        const agentDirs = await fs.readdir(companyDir, { withFileTypes: true }).catch(() => []);
        for (const agentEntry of agentDirs) {
          if (!agentEntry.isDirectory()) continue;
          const agentDir = path.join(companyDir, agentEntry.name);
          const files = await fs.readdir(agentDir, { withFileTypes: true }).catch(() => []);
          for (const fileEntry of files) {
            if (!fileEntry.isFile()) continue;
            const stat = await fs.stat(path.join(agentDir, fileEntry.name)).catch(() => null);
            if (stat) sum += stat.size;
          }
        }
        totals.set(companyId, sum);
      }
      return totals;
    },
  };
}

/** Wrap the raw {@link getStorageProvider} into the archiver's storage port. */
export function createProviderRunLogArchiverStorage(): RunLogArchiverStorage {
  return {
    putObject: (input) => getStorageProvider().putObject(input),
    async headObject(input) {
      const head = await getStorageProvider().headObject({ objectKey: input.objectKey });
      return { exists: head.exists, contentLength: head.contentLength };
    },
  };
}

/** Production wiring: bind the archiver to Drizzle, the storage provider, and disk. */
export function createRunLogArchiverFromRuntime(db: Db, config: Config): RunLogArchiver {
  const baseDir = resolveRunLogBasePath();
  return createRunLogArchiver({
    db: createDrizzleRunLogArchiverDb(db),
    storage: createProviderRunLogArchiverStorage(),
    files: createNodeRunLogArchiverFs(baseDir),
    config: resolveRunLogArchiverConfig(config),
    now: () => new Date(),
  });
}
