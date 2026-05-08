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

const TERMINAL_RESULT_SCAN_TAIL_BYTES = 256_000;

export interface RunLogTerminalResultDetection {
  found: boolean;
  isError: boolean | null;
}

// Scan the tail of a run's NDJSON log for an adapter-emitted terminal `result`
// line (Claude/Codex/Gemini stream-json all emit `{"type":"result", ...}`).
// Returns `found:true` when at least one such line is present in the tail
// window, and `isError` reflecting whatever the line indicated (`null` when
// found but indeterminate). Used by the orphan reaper and silent-run watchdog
// to recognise runs whose adapter completed even though the OS child process
// is still alive (e.g. waiting on a leaked Bash-tool helper).
export async function detectRunLogTerminalResult(
  run: { logStore?: string | null; logRef?: string | null; logBytes?: number | null },
  options?: { scanBytes?: number },
): Promise<RunLogTerminalResultDetection> {
  if (!run.logStore || !run.logRef) return { found: false, isError: null };
  const totalBytes = typeof run.logBytes === "number" ? run.logBytes : 0;
  if (totalBytes <= 0) return { found: false, isError: null };
  const scanBytes = options?.scanBytes ?? TERMINAL_RESULT_SCAN_TAIL_BYTES;

  const handle: RunLogHandle = { store: run.logStore as RunLogStoreType, logRef: run.logRef };
  const offset = Math.max(0, totalBytes - scanBytes);
  let content: string;
  try {
    const result = await getRunLogStore().read(handle, { offset, limitBytes: scanBytes });
    content = result.content;
  } catch {
    return { found: false, isError: null };
  }

  let foundResult = false;
  let isError: boolean | null = null;

  for (const envelopeLine of content.split(/\r?\n/)) {
    const trimmedEnvelope = envelopeLine.trim();
    if (!trimmedEnvelope) continue;
    let envelope: unknown;
    try {
      envelope = JSON.parse(trimmedEnvelope);
    } catch {
      continue;
    }
    if (typeof envelope !== "object" || envelope === null) continue;
    const env = envelope as { stream?: unknown; chunk?: unknown };
    if (env.stream !== "stdout" && env.stream !== "stderr") continue;
    const chunk = typeof env.chunk === "string" ? env.chunk : null;
    if (!chunk || !chunk.includes("\"type\"")) continue;

    for (const rawSubLine of chunk.split(/\r?\n/)) {
      const subLine = rawSubLine.trim();
      if (!subLine) continue;
      if (!/"type"\s*:\s*"result"/.test(subLine)) continue;
      foundResult = true;
      try {
        const parsed = JSON.parse(subLine);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj.is_error === "boolean") {
            isError = obj.is_error;
          } else if (typeof obj.subtype === "string") {
            const subtype = obj.subtype.toLowerCase();
            if (subtype === "success") isError = false;
            else if (subtype.startsWith("error")) isError = true;
          } else if (typeof obj.status === "string") {
            const status = obj.status.toLowerCase();
            if (status === "success") isError = false;
            else if (status === "error" || status === "failed") isError = true;
          } else if (typeof obj.ok === "boolean") {
            isError = !obj.ok;
          }
        }
      } catch {
        // Unparseable JSON line — keep `foundResult` true; leave `isError`
        // alone so the caller treats it as indeterminate.
      }
    }
  }

  return { found: foundResult, isError };
}
