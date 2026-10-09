import { createReadStream, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { notFound } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  createWorkspaceOperationByteRangeScanner,
  maskWorkspaceOperationUrlUserInfoBytes,
  type WorkspaceOperationMaskedByteRange,
} from "./workspace-operation-url-redaction.js";

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
  const redactionCache = new Map<string, {
    size: number;
    mtimeMs: number;
    ino: number;
    ranges: WorkspaceOperationMaskedByteRange[];
  }>();

  async function ensureDir(relativeDir: string) {
    const dir = resolveWithin(basePath, relativeDir);
    await fs.mkdir(dir, { recursive: true });
  }

  async function scanMaskedRanges(filePath: string, size: number): Promise<WorkspaceOperationMaskedByteRange[]> {
    const maxLineBytes = 16 * 1024 * 1024;
    const scanner = createWorkspaceOperationByteRangeScanner();
    const directRanges: WorkspaceOperationMaskedByteRange[] = [];
    let lineStart = 0;
    let parts: Buffer[] = [];
    let lineBytes = 0;
    let damaged = false;

    function scanLine(line: Buffer): boolean {
      const raw = line.toString("latin1");
      const record = /^\{"ts":"(?:\\.|[^"\\])*","stream":"(stdout|stderr|system)","chunk":"((?:\\.|[^"\\])*)"\}$/.exec(raw);
      let validJson = false;
      try {
        JSON.parse(raw);
        validJson = true;
      } catch {
        // A damaged or partially written record cannot be safely reassembled.
      }
      if (!record || !validJson) {
        // A skipped chunk could complete userinfo started in an earlier event.
        // Hide the unknown record and the rest of the file without moving bytes.
        directRanges.push({ start: lineStart, end: size });
        return false;
      }
      const chunkOffset = raw.lastIndexOf('"chunk":"') + '"chunk":"'.length;
      scanner.feed(record[1]!, record[2]!, lineStart + chunkOffset);
      // Also cover complete URLs in metadata outside `chunk`.
      const masked = maskWorkspaceOperationUrlUserInfoBytes(line);
      let rangeStart = -1;
      for (let index = 0; index <= line.length; index += 1) {
        const changed = index < line.length && masked[index] !== line[index];
        if (changed && rangeStart < 0) rangeStart = index;
        if (!changed && rangeStart >= 0) {
          directRanges.push({ start: lineStart + rangeStart, end: lineStart + index });
          rangeStart = -1;
        }
      }
      return true;
    }

    scan: for await (const value of createReadStream(filePath, { end: size - 1 })) {
      const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let cursor = 0;
      while (cursor < buffer.length) {
        const newline = buffer.indexOf(0x0a, cursor);
        const part = buffer.subarray(cursor, newline < 0 ? buffer.length : newline);
        parts.push(part);
        lineBytes += part.length;
        if (lineBytes > maxLineBytes) {
          // Avoid allocating an unbounded line. Hide the unread suffix when its
          // cross-event URL state cannot be safely inspected.
          directRanges.push({ start: lineStart, end: size });
          break scan;
        }
        if (newline < 0) break;
        if (!scanLine(Buffer.concat(parts, lineBytes))) {
          damaged = true;
          break scan;
        }
        lineStart += lineBytes + 1;
        parts = [];
        lineBytes = 0;
        cursor = newline + 1;
      }
    }
    if (!damaged && lineBytes > 0 && lineBytes <= maxLineBytes) scanLine(Buffer.concat(parts, lineBytes));

    const ranges = [...scanner.finish(), ...directRanges].sort((left, right) => left.start - right.start);
    const merged: WorkspaceOperationMaskedByteRange[] = [];
    for (const range of ranges) {
      const last = merged[merged.length - 1];
      if (last && last.end >= range.start) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    return merged;
  }

  async function maskedRanges(filePath: string, stat: Stats) {
    const cached = redactionCache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) {
      return cached.ranges;
    }
    const ranges = stat.size > 0 ? await scanMaskedRanges(filePath, stat.size) : [];
    redactionCache.delete(filePath);
    redactionCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, ranges });
    if (redactionCache.size > 64) redactionCache.delete(redactionCache.keys().next().value!);
    return ranges;
  }

  async function readFileRange(filePath: string, offset: number, limitBytes: number): Promise<WorkspaceOperationLogReadResult> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat) throw notFound("Workspace operation log not found");

    const start = Math.max(0, Math.min(offset, stat.size));
    // No lower clamp to `start`: when the reader is fully caught up
    // (offset === size) that clamp made end === start and produced a
    // 1-byte-past-EOF range instead of an empty read.
    const end = Math.min(start + limitBytes - 1, stat.size - 1);

    if (start > end) {
      return { content: "", nextOffset: start < stat.size ? start : undefined };
    }

    const ranges = await maskedRanges(filePath, stat);
    const file = await fs.open(filePath, "r");
    const page = Buffer.alloc(end - start + 1);
    try {
      let bytesRead = 0;
      while (bytesRead < page.length) {
        const result = await file.read(page, bytesRead, page.length - bytesRead, start + bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
    } finally {
      await file.close();
    }
    for (const range of ranges) {
      if (range.end <= start) continue;
      if (range.start > end) break;
      page.fill(0x2a, Math.max(start, range.start) - start, Math.min(end + 1, range.end) - start);
    }
    const content = page.toString("utf8");
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
      redactionCache.delete(absPath);

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

let cachedStore: WorkspaceOperationLogStore | null = null;

export function getWorkspaceOperationLogStore() {
  if (cachedStore) return cachedStore;
  const basePath = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH
    ?? path.resolve(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
  cachedStore = createLocalFileWorkspaceOperationLogStore(basePath);
  return cachedStore;
}
