import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

export type WorkspaceOperationLogStoreType = "local_file";

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

export function createLocalFileWorkspaceOperationLogStore(basePath: string): WorkspaceOperationLogStore {
  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<WorkspaceOperationLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    // Log files are created lazily on first append, so a missing file is an
    // operation that never produced output — an empty log, not an error.
    if (!stat) return { content: "" };

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
      // Deliberately touches nothing on disk: most operations never produce
      // output, and an eager per-operation file (plus a dir per company ever
      // seen) is an unbounded inode sink. The file and its directory are
      // created by the first append instead (TSMC-21945).
      const [companyId] = safeSegments(input.companyId);
      const operationId = safeSegments(input.operationId)[0]!;
      const relPath = path.join(companyId, `${operationId}.ndjson`);
      resolveWithin(basePath, relPath);

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
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.appendFile(absPath, `${line}\n`, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") {
        return { bytes: 0, compressed: false };
      }
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      // Never-appended log: nothing was written, so there is nothing to hash.
      if (!stat) return { bytes: 0, compressed: false };

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

let cachedStore: WorkspaceOperationLogStore | null = null;

export function getWorkspaceOperationLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH
    ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
  cachedStore = createLocalFileWorkspaceOperationLogStore(basePath);
  return cachedStore;
}
