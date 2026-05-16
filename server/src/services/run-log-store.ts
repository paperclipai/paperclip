import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getStorageService, type StorageService } from "../storage/index.js";

export type RunLogStoreType = "local_file" | "object_store";

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

const FLUSH_THRESHOLD_BYTES = 1024 * 1024; // 1MB

function createObjectStorageRunLogStore(storage: StorageService): RunLogStore {
  const buffers = new Map<string, { tmpPath: string; byteCount: number }>();

  function bufferKey(companyId: string, runId: string) {
    return `${companyId}::${runId}`;
  }

  async function uploadBuffer(companyId: string, objectKey: string, tmpPath: string): Promise<void> {
    const body = await fs.readFile(tmpPath);
    await storage.putObjectDirect({ companyId, objectKey, body, contentType: "application/x-ndjson" });
  }

  return {
    async begin(input) {
      const { companyId, runId } = input;
      const tmpPath = path.join(os.tmpdir(), `paperclip-runlog-${randomUUID()}.ndjson`);
      await fs.writeFile(tmpPath, "", "utf8");
      buffers.set(bufferKey(companyId, runId), { tmpPath, byteCount: 0 });
      const logRef = `${companyId}/runs/${runId}/stdout.ndjson`;
      return { store: "object_store", logRef };
    },

    async append(handle, event) {
      if (handle.store !== "object_store") return 0;
      const parts = handle.logRef.split("/");
      const companyId = parts[0]!;
      const runId = parts[2]!;
      const entry = buffers.get(bufferKey(companyId, runId));
      if (!entry) return 0;
      const line = JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk });
      const persisted = `${line}\n`;
      await fs.appendFile(entry.tmpPath, persisted, "utf8");
      const bytes = Buffer.byteLength(persisted, "utf8");
      entry.byteCount += bytes;
      if (entry.byteCount >= FLUSH_THRESHOLD_BYTES) {
        await uploadBuffer(companyId, handle.logRef, entry.tmpPath);
        entry.byteCount = 0;
      }
      return bytes;
    },

    async finalize(handle) {
      if (handle.store !== "object_store") return { bytes: 0, compressed: false };
      const parts = handle.logRef.split("/");
      const companyId = parts[0]!;
      const runId = parts[2]!;
      const entry = buffers.get(bufferKey(companyId, runId));
      if (!entry) return { bytes: 0, compressed: false };
      const body = await fs.readFile(entry.tmpPath);
      const sha256 = createHash("sha256").update(body).digest("hex");
      await storage.putObjectDirect({ companyId, objectKey: handle.logRef, body, contentType: "application/x-ndjson" });
      buffers.delete(bufferKey(companyId, runId));
      await fs.rm(entry.tmpPath, { force: true });
      return { bytes: body.length, sha256, compressed: false };
    },

    async read(handle, opts) {
      if (handle.store !== "object_store") throw notFound("Run log not found");
      const parts = handle.logRef.split("/");
      const companyId = parts[0]!;
      const result = await storage.getObject(companyId, handle.logRef);
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        result.stream.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        result.stream.on("error", reject);
        result.stream.on("end", resolve);
      });
      const full = Buffer.concat(chunks);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      const slice = full.subarray(offset, offset + limitBytes);
      const nextOffset = offset + slice.length < full.length ? offset + slice.length : undefined;
      return { content: slice.toString("utf8"), nextOffset };
    },
  };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const storage = getStorageService();
  const useObjectStore =
    process.env.PAPERCLIP_OBJECT_RUN_LOGS === "1" ||
    storage.provider !== "local_disk";
  if (useObjectStore) {
    cachedStore = createObjectStorageRunLogStore(storage);
  } else {
    const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
    cachedStore = createLocalFileRunLogStore(basePath);
  }
  return cachedStore;
}
