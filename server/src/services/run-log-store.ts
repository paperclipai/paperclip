import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { type Db, heartbeatRunLogChunks } from "@valadrien-os/db";
import { notFound } from "../errors.js";
import { resolveValadrienOsInstanceRoot } from "../home-paths.js";

export type RunLogStoreType = "local_file" | "postgres";

export interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string;
  /**
   * Runtime-only (not persisted): set by begin() so the postgres store's appends are
   * company-scoped. The read path reconstructs by runId and does not need it.
   */
  companyId?: string;
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

// Postgres-backed store. The Railway worker writes chunks here as the run streams; the Vercel
// control plane reads them back for the transcript. Both planes share the DB, so this works
// across the filesystem split that broke the old local-file logs ("Run log not found").
function createPostgresRunLogStore(db: Db): RunLogStore {
  async function readAll(runId: string): Promise<string> {
    const rows = await db
      .select({ content: heartbeatRunLogChunks.content })
      .from(heartbeatRunLogChunks)
      .where(eq(heartbeatRunLogChunks.runId, runId))
      .orderBy(asc(heartbeatRunLogChunks.seq));
    return rows.map((r) => r.content).join("");
  }
  return {
    async begin(input) {
      // No row written until the first append; a run with no output reads back as empty
      // content (not a 404), which is the desired transcript behaviour.
      return { store: "postgres", logRef: input.runId, companyId: input.companyId };
    },
    async append(handle, event) {
      if (handle.store !== "postgres") return 0;
      const persisted = `${JSON.stringify({ ts: event.ts, stream: event.stream, chunk: event.chunk })}\n`;
      await db.insert(heartbeatRunLogChunks).values({
        companyId: handle.companyId ?? "",
        runId: handle.logRef,
        stream: event.stream,
        ts: new Date(event.ts),
        content: persisted,
      });
      return Buffer.byteLength(persisted, "utf8");
    },
    async finalize(handle) {
      if (handle.store !== "postgres") return { bytes: 0, compressed: false };
      const buf = Buffer.from(await readAll(handle.logRef), "utf8");
      return { bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex"), compressed: false };
    },
    async read(handle, opts) {
      if (handle.store !== "postgres") throw notFound("Run log not found");
      const buf = Buffer.from(await readAll(handle.logRef), "utf8");
      const offset = Math.max(0, opts?.offset ?? 0);
      const limitBytes = opts?.limitBytes ?? 256_000;
      if (offset >= buf.length) return { content: "", nextOffset: buf.length };
      const end = Math.min(offset + limitBytes, buf.length);
      return { content: buf.subarray(offset, end).toString("utf8"), nextOffset: end < buf.length ? end : undefined };
    },
  };
}

let cachedLocalStore: RunLogStore | null = null;
function getLocalFileRunLogStore(): RunLogStore {
  if (cachedLocalStore) return cachedLocalStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolveValadrienOsInstanceRoot(), "data", "run-logs");
  cachedLocalStore = createLocalFileRunLogStore(basePath);
  return cachedLocalStore;
}

// Dispatcher: new runs use the postgres store (readable on both planes) when a db is available;
// existing/legacy runs (logStore="local_file") keep reading from disk. Begin/append/finalize/read
// all dispatch on the handle's store, so a mixed fleet of old + new runs both work.
export function getRunLogStore(db?: Db): RunLogStore {
  const local = getLocalFileRunLogStore();
  const pg = db ? createPostgresRunLogStore(db) : null;
  return {
    begin: (input) => (pg ? pg.begin(input) : local.begin(input)),
    append: (handle, event) => (handle.store === "postgres" && pg ? pg.append(handle, event) : local.append(handle, event)),
    finalize: (handle) => (handle.store === "postgres" && pg ? pg.finalize(handle) : local.finalize(handle)),
    read: (handle, opts) => {
      if (handle.store === "postgres") {
        if (!pg) throw notFound("Run log not found");
        return pg.read(handle, opts);
      }
      return local.read(handle, opts);
    },
  };
}
