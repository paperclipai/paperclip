import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getStorageService, type StorageService } from "../storage/index.js";

export type WorkspaceOperationLogStoreType = "local_file" | "object_store";

export interface WorkspaceOperationLogHandle {
  store: WorkspaceOperationLogStoreType;
  logRef: string;
}

export interface WorkspaceOperationLogReadOptions {
  offset?: number;
  limitBytes?: number;
}

export interface WorkspaceOperationLogReadResult {
  content: string;
  nextOffset?: number;
}

export interface WorkspaceOperationLogFinalizeSummary {
  bytes: number;
  sha256?: string;
  compressed: boolean;
}

export interface WorkspaceOperationLogStore {
  begin(input: { companyId: string; operationId: string }): Promise<WorkspaceOperationLogHandle>;
  append(
    handle: WorkspaceOperationLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(handle: WorkspaceOperationLogHandle): Promise<WorkspaceOperationLogFinalizeSummary>;
  read(handle: WorkspaceOperationLogHandle, opts?: WorkspaceOperationLogReadOptions): Promise<WorkspaceOperationLogReadResult>;
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

function createLocalFileWorkspaceOperationLogStore(basePath: string): WorkspaceOperationLogStore {
  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<WorkspaceOperationLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Workspace operation log not found");

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
      const [companyId] = safeSegments(input.companyId);
      const operationId = safeSegments(input.operationId)[0]!;
      const relDir = companyId;
      const relPath = path.join(relDir, `${operationId}.ndjson`);
      await ensureDir(relDir);

      const absPath = resolveWithin(basePath, relPath);
      await fs.writeFile(absPath, "", "utf8");

      return { store: "local_file", logRef: relPath };
    },

    async append(handle, event) {
      if (handle.store !== "local_file") return;
      const absPath = resolveWithin(basePath, handle.logRef);
      const line = JSON.stringify({
        ts: event.ts,
        stream: event.stream,
        chunk: event.chunk,
      });
      await fs.appendFile(absPath, `${line}\n`, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Workspace operation log not found");

      const hash = await sha256File(absPath);
      return {
        bytes: stat.size,
        sha256: hash,
        compressed: false,
      };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") {
        throw notFound("Workspace operation log not found");
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      return readFileRange(absPath, offset, limitBytes);
    },
  };
}

function createObjectStorageWorkspaceOpLogStore(storage: StorageService): WorkspaceOperationLogStore {
  const buffers = new Map<string, { tmpPath: string; byteCount: number }>();

  function bufferKey(companyId: string, operationId: string) {
    return `${companyId}::${operationId}`;
  }

  return {
    async begin(input) {
      const { companyId, operationId } = input;
      const tmpPath = path.join(os.tmpdir(), `paperclip-wsoplog-${randomUUID()}.ndjson`);
      await fs.writeFile(tmpPath, "", "utf8");
      buffers.set(bufferKey(companyId, operationId), { tmpPath, byteCount: 0 });
      const logRef = `${companyId}/workspace-ops/${operationId}/log.ndjson`;
      return { store: "object_store", logRef };
    },

    async append(handle, event) {
      if (handle.store !== "object_store") return;
      const parts = handle.logRef.split("/");
      const companyId = parts[0]!;
      const operationId = parts[2]!;
      const entry = buffers.get(bufferKey(companyId, operationId));
      if (!entry) return;
      const line = JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk });
      await fs.appendFile(entry.tmpPath, `${line}\n`, "utf8");
      entry.byteCount += Buffer.byteLength(`${line}\n`, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "object_store") return { bytes: 0, compressed: false };
      const parts = handle.logRef.split("/");
      const companyId = parts[0]!;
      const operationId = parts[2]!;
      const entry = buffers.get(bufferKey(companyId, operationId));
      if (!entry) return { bytes: 0, compressed: false };
      const body = await fs.readFile(entry.tmpPath);
      const sha256 = createHash("sha256").update(body).digest("hex");
      await storage.putObjectDirect({ companyId, objectKey: handle.logRef, body, contentType: "application/x-ndjson" });
      buffers.delete(bufferKey(companyId, operationId));
      await fs.rm(entry.tmpPath, { force: true });
      return { bytes: body.length, sha256, compressed: false };
    },

    async read(handle, opts) {
      if (handle.store !== "object_store") throw notFound("Workspace operation log not found");
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

let cachedStore: WorkspaceOperationLogStore | null = null;

export function getWorkspaceOperationLogStore() {
  if (cachedStore) return cachedStore;
  if (getStorageService().provider !== "local_disk") {
    cachedStore = createObjectStorageWorkspaceOpLogStore(getStorageService());
  } else {
    const basePath = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH
      ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
    cachedStore = createLocalFileWorkspaceOperationLogStore(basePath);
  }
  return cachedStore;
}
