import { createReadStream, createWriteStream, type Dirent, promises as fs } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export interface RunLogRetentionPolicy {
  /** Files newer than this stay uncompressed. Older files get gzipped. */
  uncompressedDays: number;
  /** Files older than this (compressed or not) are deleted. */
  compressedDays: number;
  /**
   * Files larger than this byte threshold are gzipped on the next tick even if
   * they are still inside the uncompressed window — corresponds to the
   * "rotate at 500 MB or daily, whichever comes first" rule.
   */
  maxFileBytes: number;
  /**
   * Skip files whose mtime is within this grace window. Avoids racing with
   * still-active run writers that haven't finalized yet.
   */
  graceMinutes: number;
}

export interface RunLogRetentionResult {
  scannedFiles: number;
  rotatedBytes: number;
  gzippedFiles: number;
  deletedFiles: number;
  errors: number;
}

const DEFAULT_POLICY: RunLogRetentionPolicy = {
  uncompressedDays: 3,
  compressedDays: 7,
  maxFileBytes: 500 * 1024 * 1024,
  graceMinutes: 60,
};

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function resolveRunLogRetentionPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RunLogRetentionPolicy {
  return {
    uncompressedDays: parsePositiveNumber(env.PAPERCLIP_RUN_LOG_UNCOMPRESSED_DAYS, DEFAULT_POLICY.uncompressedDays),
    compressedDays: parsePositiveNumber(env.PAPERCLIP_RUN_LOG_COMPRESSED_DAYS, DEFAULT_POLICY.compressedDays),
    maxFileBytes: parsePositiveNumber(env.PAPERCLIP_RUN_LOG_MAX_FILE_BYTES, DEFAULT_POLICY.maxFileBytes),
    graceMinutes: parsePositiveNumber(env.PAPERCLIP_RUN_LOG_ROTATE_GRACE_MINUTES, DEFAULT_POLICY.graceMinutes),
  };
}

export function resolveDefaultRunLogBasePath(): string {
  return process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
}

/**
 * Retention errors that are safe to swallow without taking down the server.
 * Disk-pressure / permission / vanished-file conditions hit during a scan are
 * always logged but never escalate — the run-logs tree must not crash Paperclip.
 */
export const RECOVERABLE_RUN_LOG_RETENTION_FS_CODES = new Set([
  "ENOSPC",
  "EROFS",
  "EDQUOT",
  "EACCES",
  "EPERM",
  "ENOENT",
  "EBUSY",
  "EIO",
]);

function isRecoverableFsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && RECOVERABLE_RUN_LOG_RETENTION_FS_CODES.has(code);
}

async function gzipFileAtomic(srcPath: string): Promise<{ srcBytes: number }> {
  const stat = await fs.stat(srcPath);
  const tmpPath = `${srcPath}.gz.tmp`;
  const finalPath = `${srcPath}.gz`;
  const source = createReadStream(srcPath);
  const sink = createWriteStream(tmpPath);
  try {
    await pipeline(source, createGzip(), sink);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
  await fs.rename(tmpPath, finalPath);
  await fs.unlink(srcPath).catch(() => undefined);
  return { srcBytes: stat.size };
}

async function walkRunLogDirs(basePath: string): Promise<string[]> {
  const out: string[] = [];
  let companyEntries: Dirent[];
  try {
    companyEntries = (await fs.readdir(basePath, { withFileTypes: true })) as Dirent[];
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return out;
    throw err;
  }
  for (const company of companyEntries) {
    if (!company.isDirectory()) continue;
    const agentRoot = path.join(basePath, company.name);
    let agentEntries: Dirent[];
    try {
      agentEntries = (await fs.readdir(agentRoot, { withFileTypes: true })) as Dirent[];
    } catch (err) {
      if (isRecoverableFsError(err)) continue;
      throw err;
    }
    for (const agent of agentEntries) {
      if (!agent.isDirectory()) continue;
      out.push(path.join(agentRoot, agent.name));
    }
  }
  return out;
}

export interface RotateRunLogsOptions {
  basePath?: string;
  policy?: RunLogRetentionPolicy;
  now?: Date;
  onWarn?: (event: { path: string; err: unknown }) => void;
}

export async function rotateRunLogs(opts: RotateRunLogsOptions = {}): Promise<RunLogRetentionResult> {
  const basePath = opts.basePath ?? resolveDefaultRunLogBasePath();
  const policy = opts.policy ?? resolveRunLogRetentionPolicyFromEnv();
  const now = (opts.now ?? new Date()).getTime();
  const result: RunLogRetentionResult = {
    scannedFiles: 0,
    rotatedBytes: 0,
    gzippedFiles: 0,
    deletedFiles: 0,
    errors: 0,
  };

  const graceMs = policy.graceMinutes * 60 * 1000;
  const uncompressedMs = policy.uncompressedDays * 24 * 60 * 60 * 1000;
  const compressedMs = policy.compressedDays * 24 * 60 * 60 * 1000;

  const reportWarn = (target: string, err: unknown) => {
    result.errors += 1;
    if (opts.onWarn) opts.onWarn({ path: target, err });
  };

  let agentDirs: string[];
  try {
    agentDirs = await walkRunLogDirs(basePath);
  } catch (err) {
    if (isRecoverableFsError(err)) {
      reportWarn(basePath, err);
      return result;
    }
    throw err;
  }

  for (const agentDir of agentDirs) {
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(agentDir, { withFileTypes: true })) as Dirent[];
    } catch (err) {
      if (isRecoverableFsError(err)) {
        reportWarn(agentDir, err);
        continue;
      }
      throw err;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = path.join(agentDir, entry.name);
      let stat;
      try {
        stat = await fs.stat(fullPath);
      } catch (err) {
        if (isRecoverableFsError(err)) {
          reportWarn(fullPath, err);
          continue;
        }
        throw err;
      }
      result.scannedFiles += 1;
      const age = now - stat.mtimeMs;
      const ext = entry.name.endsWith(".ndjson.gz.tmp")
        ? "tmp"
        : entry.name.endsWith(".ndjson.gz")
        ? "gz"
        : entry.name.endsWith(".ndjson")
          ? "ndjson"
          : "other";
      if (ext === "other") continue;

      if (ext === "tmp") {
        if (age < graceMs) continue;
        try {
          await fs.unlink(fullPath);
          result.deletedFiles += 1;
        } catch (err) {
          if (isRecoverableFsError(err)) {
            reportWarn(fullPath, err);
            continue;
          }
          throw err;
        }
        continue;
      }

      // Retention: delete files past the compressed-window age regardless of form.
      if (age > compressedMs) {
        try {
          await fs.unlink(fullPath);
          result.deletedFiles += 1;
        } catch (err) {
          if (isRecoverableFsError(err)) {
            reportWarn(fullPath, err);
            continue;
          }
          throw err;
        }
        continue;
      }

      if (ext !== "ndjson") continue;

      // Skip files modified inside the grace window — likely still being appended.
      if (age < graceMs) continue;

      const sizeTrigger = stat.size >= policy.maxFileBytes;
      const ageTrigger = age > uncompressedMs;
      if (!sizeTrigger && !ageTrigger) continue;

      try {
        const { srcBytes } = await gzipFileAtomic(fullPath);
        result.gzippedFiles += 1;
        result.rotatedBytes += srcBytes;
      } catch (err) {
        if (isRecoverableFsError(err)) {
          reportWarn(fullPath, err);
          continue;
        }
        throw err;
      }
    }
  }

  return result;
}

export function formatRunLogRetentionSummary(result: RunLogRetentionResult): string {
  return `runner-logs: rotated ${result.rotatedBytes} bytes, gz'd ${result.gzippedFiles} files, deleted ${result.deletedFiles} files`;
}
