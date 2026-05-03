import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

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

    const buf = Buffer.concat(chunks);

    // Trim trailing bytes that form an incomplete UTF-8 multi-byte character
    // so they are included in the next read instead of becoming U+FFFD.
    let trimEnd = buf.length;
    if (trimEnd > 0) {
      // Walk backwards to find a valid UTF-8 boundary.
      // A UTF-8 continuation byte has the pattern 10xxxxxx (0x80..0xBF).
      // A leading byte tells how many continuation bytes follow:
      //   110xxxxx = 2-byte, 1110xxxx = 3-byte, 11110xxx = 4-byte.
      let trailingContinuation = 0;
      while (trailingContinuation < 4 && trailingContinuation < trimEnd) {
        const byte = buf[trimEnd - 1 - trailingContinuation]!;
        if ((byte & 0xc0) !== 0x80) break; // not a continuation byte
        trailingContinuation++;
      }
      if (trailingContinuation > 0 && trailingContinuation < trimEnd) {
        const leadByte = buf[trimEnd - 1 - trailingContinuation]!;
        let expectedContinuation = 0;
        if ((leadByte & 0xe0) === 0xc0) expectedContinuation = 1;       // 2-byte sequence
        else if ((leadByte & 0xf0) === 0xe0) expectedContinuation = 2;  // 3-byte sequence
        else if ((leadByte & 0xf8) === 0xf0) expectedContinuation = 3;  // 4-byte sequence
        if (trailingContinuation < expectedContinuation) {
          // Incomplete character — exclude the partial bytes
          trimEnd -= trailingContinuation + 1;
        }
      }
    }

    const content = buf.subarray(0, trimEnd).toString("utf8");
    const bytesConsumed = start + trimEnd;
    const nextOffset = bytesConsumed < stat.size ? bytesConsumed : undefined;
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
