import { createReadStream } from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { Parser, type ReadEntry } from "tar";

export type ImportedArchiveInspection = {
  bundleName: string;
  entryCount: number;
};

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
  if (entry.meta || IGNORED_ENTRY_TYPES.has(entry.type)) {
    return null;
  }
  if (!SUPPORTED_ENTRY_TYPES.has(entry.type)) {
    throw new Error("Backup archive may only contain regular files and directories.");
  }
  return normalizeArchiveEntryPath(entry.path);
}

export async function inspectImportedArchive(archivePath: string): Promise<ImportedArchiveInspection> {
  const entries: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const source = createReadStream(archivePath);
    const gunzip = createGunzip();
    const parser = new Parser({ strict: true });
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      const normalized = error instanceof Error ? error : new Error(String(error));
      source.destroy();
      gunzip.destroy();
      parser.abort(normalized);
      reject(normalized);
    };

    source.on("error", fail);
    gunzip.on("error", fail);
    parser.on("error", fail);
    parser.on("entry", (entry: ReadEntry) => {
      try {
        const normalized = classifyArchiveEntry(entry);
        if (normalized) {
          entries.push(normalized);
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

    source.pipe(gunzip).pipe(parser);
  });

  if (entries.length === 0) {
    throw new Error("Backup archive is empty.");
  }

  const topLevelNames = new Set<string>();
  for (const entry of entries) {
    const topLevel = entry.split("/")[0];
    if (!topLevel || topLevel === "." || topLevel === "..") {
      throw new Error("Backup archive contains an invalid top-level directory.");
    }
    topLevelNames.add(topLevel);
  }

  if (topLevelNames.size !== 1) {
    throw new Error("Backup archive must contain exactly one top-level bundle directory.");
  }

  const bundleName = Array.from(topLevelNames)[0]!;
  if (!isSafeBundleName(bundleName)) {
    throw new Error(`Backup bundle name '${bundleName}' is not allowed.`);
  }

  return {
    bundleName,
    entryCount: entries.length,
  };
}
