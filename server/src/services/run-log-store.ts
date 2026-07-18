import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import type { StorageProvider } from "../storage/types.js";

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
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string; seq?: number },
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

function normalizeKeyPrefix(prefix: string | undefined): string {
  if (!prefix) return "";
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface DurableRunLogStoreOptions {
  basePath: string;
  // When provided, completed logs are mirrored to object storage on finalize and
  // served from there on read whenever the local file is missing (e.g. the pod
  // rolled and wiped the emptyDir). When omitted, the store is local-only (the
  // historical behaviour: a restart loses the log).
  s3?: { provider: StorageProvider; keyPrefix?: string };
}

// Run-log store with TRANSPARENT durability. The store id stays "local_file" so
// nothing downstream (feedback.ts, the heartbeat read cast, fixtures) changes;
// the S3 mirror is keyed by the same logRef and is purely an implementation
// detail. Live append/tail stays on the pod-local file (fast, no per-chunk PUT);
// on finalize the complete .ndjson is uploaded to object storage; on read we try
// local first and fall back to S3 when the local file is gone. This is the fix
// for "Run log not found" after a deploy/restart (the /paperclip data dir is an
// emptyDir in cloud_tenant mode -- persistence is disabled to avoid the
// operator's privileged selinux-relabel init container in our hardened ns).
export function createDurableRunLogStore(options: DurableRunLogStoreOptions): RunLogStore {
  const { basePath } = options;
  const s3 = options.s3;
  const s3Prefix = normalizeKeyPrefix(s3?.keyPrefix);

  function s3Key(logRef: string): string {
    return s3Prefix ? `${s3Prefix}/${logRef}` : logRef;
  }

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function readLocalRange(
    filePath: string,
    offset: number,
    limitBytes: number,
  ): Promise<RunLogReadResult | null> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) return null;
    const start = Math.max(0, Math.min(offset, stat.size));
    const end = Math.max(start, Math.min(start + limitBytes - 1, stat.size - 1));
    if (start > end) return { content: "", nextOffset: start };

    const chunks: Buffer[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const stream = createReadStream(filePath, { start, end });
        stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on("error", reject);
        stream.on("end", () => resolve());
      });
    } catch (err) {
      // File deleted between stat() and open (pod-roll cleanup racing a read):
      // treat as missing so the caller falls through to the S3 mirror instead
      // of surfacing the very "Run log not found" this store exists to prevent.
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
      throw err;
    }
    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < stat.size ? end + 1 : undefined;
    return { content, nextOffset };
  }

  async function readS3Range(
    logRef: string,
    offset: number,
    limitBytes: number,
  ): Promise<RunLogReadResult> {
    if (!s3) throw notFound("Run log not found");
    const key = s3Key(logRef);
    const head = await s3.provider.headObject({ objectKey: key });
    if (!head.exists) throw notFound("Run log not found");
    const total = head.contentLength ?? 0;
    const start = Math.max(0, Math.min(offset, total));
    const end = Math.max(start, Math.min(start + limitBytes - 1, total - 1));
    if (start > end || total === 0) return { content: "", nextOffset: start < total ? start : undefined };

    const result = await s3.provider.getObject({ objectKey: key, range: { start, end } });
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      result.stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      result.stream.on("error", reject);
      result.stream.on("end", () => resolve());
    });
    const content = Buffer.concat(chunks).toString("utf8");
    const nextOffset = end + 1 < total ? end + 1 : undefined;
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
        // Monotonic per-run sequence so readers can dedupe and order records
        // even when several identical chunks share the same millisecond ts
        // (common for ACP-style token deltas).
        ...(typeof event.seq === "number" && Number.isFinite(event.seq) ? { seq: event.seq } : {}),
      });
      const persisted = `${line}\n`;
      await fs.appendFile(absPath, persisted, "utf8");
      return Buffer.byteLength(persisted, "utf8");
    },

    async finalize(handle) {
      if (handle.store !== "local_file") return { bytes: 0, compressed: false };
      const absPath = resolveWithin(basePath, handle.logRef);
      const stat = await fs.stat(absPath).catch(() => null);
      if (!stat) throw notFound("Run log not found");
      const hash = await sha256File(absPath);

      // Mirror the completed log to object storage so it survives a pod roll.
      // Best-effort upload failures must NOT fail run finalization (which also
      // records cost/usage); the local copy still serves reads until the pod
      // rolls, and a failed mirror only loses durability for that one run.
      if (s3) {
        try {
          // Stream from disk instead of buffering the whole .ndjson in the
          // heap; long agent sessions can produce large logs. The file is
          // complete at this point, so stat.size is the exact content length.
          await s3.provider.putObject({
            objectKey: s3Key(handle.logRef),
            body: createReadStream(absPath),
            contentType: "application/x-ndjson",
            contentLength: stat.size,
          });
        } catch (err) {
          // Best-effort: finalization must not break, but a persistently
          // failing mirror (bad creds/bucket/endpoint) should be visible to
          // operators before a pod roll makes the logs unreadable.
          console.warn(
            `[run-log-store] Failed to mirror run log to object storage (key: ${s3Key(handle.logRef)}):`,
            err,
          );
        }
      }

      return { bytes: stat.size, sha256: hash, compressed: false };
    },

    async read(handle, opts) {
      if (handle.store !== "local_file") throw notFound("Run log not found");
      const absPath = resolveWithin(basePath, handle.logRef);
      const offset = opts?.offset ?? 0;
      const limitBytes = opts?.limitBytes ?? 256_000;
      const local = await readLocalRange(absPath, offset, limitBytes);
      if (local) return local;
      // Local file gone (pod rolled) -> serve from the S3 mirror if configured.
      return readS3Range(handle.logRef, offset, limitBytes);
    },
  };
}

// Build the run-log S3 mirror from dedicated RUN_LOG_S3_* env. Deliberately
// separate from PAPERCLIP_STORAGE_PROVIDER so enabling durable run logs does
// NOT redirect the product's workspace/file storage (smaller blast radius).
// Unset RUN_LOG_S3_BUCKET -> no mirror -> local-only (safe degrade). Creds come
// from the standard AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY chain.
function resolveRunLogS3(): { provider: StorageProvider; keyPrefix?: string } | undefined {
  const bucket = process.env.RUN_LOG_S3_BUCKET?.trim();
  if (!bucket) return undefined;
  const provider = createS3StorageProvider({
    bucket,
    region: process.env.RUN_LOG_S3_REGION?.trim() || "us-east-1",
    endpoint: process.env.RUN_LOG_S3_ENDPOINT?.trim() || undefined,
    prefix: undefined, // prefixing is handled by keyPrefix below (kept off the provider)
    forcePathStyle: process.env.RUN_LOG_S3_FORCE_PATH_STYLE
      ? process.env.RUN_LOG_S3_FORCE_PATH_STYLE === "true"
      : true, // Cubbit (and most S3-compatible endpoints) need path-style
  });
  return { provider, keyPrefix: process.env.RUN_LOG_S3_PREFIX?.trim() || "run-logs" };
}

let cachedStore: RunLogStore | null = null;

export function getRunLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.RUN_LOG_BASE_PATH ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "run-logs");
  cachedStore = createDurableRunLogStore({ basePath, s3: resolveRunLogS3() });
  return cachedStore;
}
