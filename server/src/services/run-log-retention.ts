import { promises as fs } from "node:fs";
import path from "node:path";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_DR_ROOT = path.resolve("/Volumes/X10 Pro/ThinkStack-DR");

export interface RunLogRetentionOptions {
  basePath: string;
  retentionDays?: number;
  archivePath?: string;
  dryRun?: boolean;
  batchSize?: number;
}

export interface RunLogRetentionResult {
  cutoff: Date;
  dryRun: boolean;
  scannedFiles: number;
  retainedFiles: number;
  prunedFiles: number;
  archivedFiles: number;
  bytesPruned: number;
  archiveSkipped: boolean;
}

export function resolveRunLogArchivePath(input: {
  basePath?: string;
  archivePath?: string;
} = {}): string | undefined {
  const explicitArchivePath = input.archivePath?.trim();
  if (explicitArchivePath) return path.resolve(explicitArchivePath);

  const resolvedBasePath = path.resolve(
    input.basePath ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs"),
  );
  const defaultBasePath = path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  if (resolvedBasePath !== defaultBasePath) return undefined;

  return path.resolve(
    DEFAULT_DR_ROOT,
    "paperclip",
    "instances",
    resolvePaperclipInstanceId(),
    "run-logs",
  );
}

async function walkFiles(root: string): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function isArchiveVolumeAvailable(archivePath: string): Promise<boolean> {
  const resolved = path.resolve(archivePath);
  const parts = resolved.split(path.sep).filter(Boolean);
  if (parts[0] !== "Volumes" || parts.length < 2) return true;
  const volumeRoot = path.join(path.sep, parts[0], parts[1]!);
  try {
    const stat = await fs.stat(volumeRoot);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function pruneEmptyDirs(root: string, startDir: string): Promise<void> {
  let current = path.resolve(startDir);
  const rootPath = path.resolve(root);
  while (current.startsWith(rootPath) && current !== rootPath) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) break;
    await fs.rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
}

async function archiveAndDelete(source: string, basePath: string, archivePath: string): Promise<void> {
  const relPath = path.relative(basePath, source);
  const dest = path.join(archivePath, relPath);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(source, dest);
  const [srcStat, destStat] = await Promise.all([fs.stat(source), fs.stat(dest)]);
  if (srcStat.size !== destStat.size) {
    throw new Error(`Archived file size mismatch for ${relPath}`);
  }
  await fs.unlink(source);
}

export async function pruneRunLogs(options: RunLogRetentionOptions): Promise<RunLogRetentionResult> {
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1_000);
  const dryRun = options.dryRun ?? false;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const basePath = path.resolve(options.basePath);
  const archivePath = resolveRunLogArchivePath({
    basePath,
    archivePath: options.archivePath,
  });
  const archiveSkipped = archivePath ? !(await isArchiveVolumeAvailable(archivePath)) : false;

  const result: RunLogRetentionResult = {
    cutoff,
    dryRun,
    scannedFiles: 0,
    retainedFiles: 0,
    prunedFiles: 0,
    archivedFiles: 0,
    bytesPruned: 0,
    archiveSkipped,
  };

  if (archiveSkipped) {
    logger.warn({ archivePath }, "Run-log retention skipped archive because the target volume is unavailable");
    return result;
  }

  const files = await walkFiles(basePath);
  for (const file of files) {
    if (result.prunedFiles >= batchSize && !dryRun) break;
    if (!file.endsWith(".ndjson")) continue;
    result.scannedFiles += 1;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) continue;
    if (stat.mtime >= cutoff) {
      result.retainedFiles += 1;
      continue;
    }

    if (dryRun) {
      result.prunedFiles += 1;
      result.bytesPruned += stat.size;
      if (archivePath) result.archivedFiles += 1;
      continue;
    }

    if (archivePath) {
      await archiveAndDelete(file, basePath, archivePath);
      result.archivedFiles += 1;
    } else {
      await fs.unlink(file);
    }
    result.prunedFiles += 1;
    result.bytesPruned += stat.size;
    await pruneEmptyDirs(basePath, path.dirname(file));
  }

  if (result.prunedFiles > 0 || dryRun) {
    logger.info(
      {
        ...result,
        retentionDays,
        archivePath,
        basePath,
        batchSize,
      },
      dryRun ? "Run-log retention dry-run" : "Pruned expired run logs",
    );
  }

  return result;
}

export function startRunLogRetention(
  options: RunLogRetentionOptions & { intervalMs?: number },
): () => void {
  const retentionDays = options.retentionDays;
  if (!retentionDays || !Number.isFinite(retentionDays) || retentionDays <= 0) {
    return () => {};
  }
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;

  const run = () =>
    pruneRunLogs(options).catch((err) => {
      logger.warn({ err, basePath: options.basePath, archivePath: options.archivePath }, "Run-log retention sweep failed");
    });

  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  void run();

  logger.info(
    {
      retentionDays,
      intervalMs,
      basePath: options.basePath,
      archivePath: options.archivePath,
    },
    "Run-log retention enabled",
  );
  return () => clearInterval(timer);
}
