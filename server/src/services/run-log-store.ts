import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

export type RunLogStoreType = "local_file";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
}

export interface RunLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface RunLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface RunLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<number>;
  finalize(handle: RunLogHandle): Promise<RunLogFinalizeSummary>;
  read(handle: RunLogHandle, opts?: RunLogReadOptions): Promise<RunLogReadResult>;
}

export interface RunLogPruneSummary {
  scannedFiles: number;
  prunedFiles: number;
  prunedBytes: number;
}

const RUN_LOG_RETENTION_DAYS_DEFAULT = 30;
const RUN_LOG_RETENTION_SWEEP_INTERVAL_MS_DEFAULT = 6 * 60 * 60 * 1_000;
const RUN_LOG_RETENTION_MAX_DELETES_PER_SWEEP = 5_000;

function safeSegments(...segments: string[]) {
  return segments.map((segment) => segment.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function resolveWithin(basePath: string, relativePath: string) {
  const resolved = path.resolve(basePath, relativePath);
  const base = path.resolve(basePath) + path.sep;
  if (!resolved.startsWith(base) && resolved !== path.resolve(basePath)) {
    throw new Error("Invalid log path");
  }
  return resolved;
}

function createLocalFileRunLogStore(basePath: string): RunLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<RunLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Run log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));

    if (start > end) {
      return { content: "", nextOffset: start };
    }

    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath, { start, end });
      stream.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve());
    });

    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function sha256File(filePath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  return {
    async begin(input) {
      const [companyId, agentId] = safeSegments(input.companyId, input.agentId);
      const runId = safeSegments(input.runId)[0]!;
      const relDir = path.join(companyId, agentId);
      const relPath = path.join(relDir, `${runId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return 0;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
      });
      const persisted = `${line}\n`;
      await fs.appendFile(absPath, persisted, "utf8");
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Run log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createLocalFileRunLogStore(basePath);
  return cachedStore;
}

async function listFilesRecursively(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(fullPath));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

async function pruneEmptyDirs(dirPath: string, stopAtPath: string): Promise<void> {
  const resolvedStop = path.resolve(stopAtPath);
  let current = path.resolve(dirPath);
  while (current.startsWith(resolvedStop) && current !== resolvedStop) {
    const entries = await fs.readdir(current).catch(() => null);
    if (!entries || entries.length > 0) break;
    await fs.rmdir(current).catch(() => {});
    current = path.dirname(current);
  }
}

export async function pruneExpiredRunLogs(input?: {
  basePath?: string;
  retentionDays?: number;
  maxDeletes?: number;
  now?: Date;
}): Promise<RunLogPruneSummary> {
  const basePath = input?.basePath ?? process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  const retentionDays = Math.max(1, Math.floor(input?.retentionDays ?? RUN_LOG_RETENTION_DAYS_DEFAULT));
  const maxDeletes = Math.max(1, Math.floor(input?.maxDeletes ?? RUN_LOG_RETENTION_MAX_DELETES_PER_SWEEP));
  const now = input?.now ?? new Date();
  const cutoffMs = now.getTime() - (retentionDays * 24 * 60 * 60 * 1_000);
  const resolvedBasePath = path.resolve(basePath);
  const files = await listFilesRecursively(resolvedBasePath);

  let prunedFiles = 0;
  let prunedBytes = 0;
  for (const filePath of files) {
    if (prunedFiles >= maxDeletes) break;
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) continue;
    if (stat.mtimeMs >= cutoffMs) continue;

    await fs.rm(filePath, { force: true }).catch(() => {});
    prunedFiles += 1;
    prunedBytes += stat.size;
    await pruneEmptyDirs(path.dirname(filePath), resolvedBasePath);
  }

  return {
    scannedFiles: files.length,
    prunedFiles,
    prunedBytes,
  };
}

export function startRunLogRetentionSweep(input?: {
  basePath?: string;
  retentionDays?: number;
  intervalMs?: number;
  maxDeletes?: number;
}): () => void {
  const basePath = input?.basePath ?? process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  const retentionDays = Math.max(
    1,
    Math.floor(input?.retentionDays ?? (Number(process.env.RUN_LOG_RETENTION_DAYS) || RUN_LOG_RETENTION_DAYS_DEFAULT)),
  );
  const intervalMs = Math.max(
    60_000,
    Math.floor(input?.intervalMs ?? (Number(process.env.RUN_LOG_RETENTION_SWEEP_INTERVAL_MS) || RUN_LOG_RETENTION_SWEEP_INTERVAL_MS_DEFAULT)),
  );
  const maxDeletes = Math.max(1, Math.floor(input?.maxDeletes ?? RUN_LOG_RETENTION_MAX_DELETES_PER_SWEEP));

  const runSweep = (phase: "initial" | "periodic") => {
    pruneExpiredRunLogs({ basePath, retentionDays, maxDeletes })
      .then((summary) => {
        if (summary.prunedFiles > 0) {
          logger.info(
            { ...summary, retentionDays, basePath },
            `${phase === "initial" ? "Initial" : "Periodic"} heartbeat run log retention sweep pruned files`,
          );
        }
      })
      .catch((err) => {
        logger.warn({ err, retentionDays, basePath }, `${phase === "initial" ? "Initial" : "Periodic"} heartbeat run log retention sweep failed`);
      });
  };

  runSweep("initial");
  const timer = setInterval(() => runSweep("periodic"), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
