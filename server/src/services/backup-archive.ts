import { createReadStream } from "node:fs";
import path from "node:path";
import { Transform } from "node:stream";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";

export type ImportedArchiveInspection = {
  bundleName: string;
  entryCount: number;
};

export type ImportedArchiveInspectionLimits = {
  maxEntries?: number;
  maxUncompressedBytes?: number;
};

const DEFAULT_MAX_ARCHIVE_ENTRIES = 100_000;
const DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 10 * 1024 * 1024 * 1024;
const SAFE_BUNDLE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const SUPPORTED_ENTRY_TYPES = new Set([
  "File",
  "OldFile",
  "ContiguousFile",
  "Directory",
]);
const IGNORED_ENTRY_TYPES = new Set([
  "GlobalExtendedHeader",
  "ExtendedHeader",
  "NextFileHasLongLinkpath",
  "NextFileHasLongPath",
  "OldExtendedHeader",
]);

function isSafeBundleName(value: string): boolean {
  return SAFE_BUNDLE_NAME_RE.test(value) && !value.startsWith(".") && !value.includes("..");
}

function normalizeArchiveEntryPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^\.\/+/, "");
  if (!trimmed) {
    throw new Error("Backup archive contains an empty entry path.");
  }
  if (trimmed.startsWith("/") || trimmed.includes("\0")) {
    throw new Error("Backup archive contains an unsafe absolute path.");
  }

  const normalized = path.posix.normalize(trimmed.replace(/\/+$/, ""));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Backup archive contains a path traversal entry.");
  }

  return normalized;
}

function classifyArchiveEntry(entry: ReadEntry): string | null {
  if (entry.header.path?.includes("\\") || entry.path.includes("\\")) {
    throw new Error("Backup archive contains a non-POSIX path separator.");
  }
  if (entry.meta || IGNORED_ENTRY_TYPES.has(entry.type)) {
    return null;
  }
  if (!SUPPORTED_ENTRY_TYPES.has(entry.type)) {
    throw new Error("Backup archive may only contain regular files and directories.");
  }
  return normalizeArchiveEntryPath(entry.path);
}

function resolveInspectionLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`Backup archive inspection ${label} must be a positive integer.`);
  }
  return limit;
}

export async function inspectImportedArchive(
  archivePath: string,
  limits: ImportedArchiveInspectionLimits = {},
): Promise<ImportedArchiveInspection> {
  const maxEntries = resolveInspectionLimit(limits.maxEntries, DEFAULT_MAX_ARCHIVE_ENTRIES, "maxEntries");
  const maxUncompressedBytes = resolveInspectionLimit(
    limits.maxUncompressedBytes,
    DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    "maxUncompressedBytes",
  );
  let archiveEntryCount = 0;
  let entryCount = 0;
  let declaredPayloadBytes = 0;
  let bundleName: string | null = null;
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(archivePath);
    const gunzip = createGunzip();
    let uncompressedBytes = 0;
    const uncompressedSizeLimiter = new Transform({
      transform(chunk, _encoding, callback) {
        uncompressedBytes += chunk.length;
        if (uncompressedBytes > maxUncompressedBytes) {
          callback(new Error(`Backup archive exceeds the maximum uncompressed size of ${maxUncompressedBytes} bytes.`));
          return;
        }
        callback(null, chunk);
      },
    });
    const parser = new Parser({ strict: true });
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const normalized = error instanceof Error ? error : new Error(String(error));
      source.destroy();
      gunzip.destroy();
      uncompressedSizeLimiter.destroy();
      parser.abort(normalized);
      reject(normalized);
    };

    source.on("error", fail);
    gunzip.on("error", fail);
    uncompressedSizeLimiter.on("error", fail);
    parser.on("error", fail);
    parser.on("entry", (entry: ReadEntry) => {
      try {
        if (++archiveEntryCount > maxEntries) {
          throw new Error(`Backup archive contains more than ${maxEntries} entries.`);
        }
        const normalized = classifyArchiveEntry(entry);
        if (normalized) {
          if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
            throw new Error("Backup archive contains an invalid entry size.");
          }
          declaredPayloadBytes += entry.size;
          if (declaredPayloadBytes > maxUncompressedBytes) {
            throw new Error(`Backup archive exceeds the maximum uncompressed size of ${maxUncompressedBytes} bytes.`);
          }
          entryCount += 1;
          const separatorIndex = normalized.indexOf("/");
          const topLevel = separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex);
          if (!topLevel || topLevel === "." || topLevel === "..") {
            throw new Error("Backup archive contains an invalid top-level directory.");
          }
          if (bundleName === null) {
            bundleName = topLevel;
          } else if (bundleName !== topLevel) {
            throw new Error("Backup archive must contain exactly one top-level bundle directory.");
          }
        }
        entry.resume();
      } catch (error) {
        fail(error);
      }
    });
    parser.on("close", () => {
      if (settled) return;
      settled = true;
      resolve();
    });

    source.pipe(gunzip).pipe(uncompressedSizeLimiter).pipe(parser);
  });

  if (entryCount === 0 || bundleName === null) {
    throw new Error("Backup archive is empty.");
  }

  if (!isSafeBundleName(bundleName)) {
    throw new Error(`Backup bundle name '${bundleName}' is not allowed.`);
  }

  return {
    bundleName,
    entryCount,
  };
}
