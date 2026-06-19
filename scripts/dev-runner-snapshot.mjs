import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { shouldTrackDevServerPath } from "./dev-runner-paths.mjs";

const defaultFileSystem = {
  existsSync,
  readdirSync,
  statSync,
};

export function isMissingPathError(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function toRelativePath(repoRoot, absolutePath) {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

export function readSignature(absolutePath, fileSystem = defaultFileSystem) {
  try {
    const stats = fileSystem.statSync(absolutePath);
    return `${Math.trunc(stats.mtimeMs)}:${stats.size}`;
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export function addFileToSnapshot(snapshot, absolutePath, options) {
  const relativePath = toRelativePath(options.repoRoot, absolutePath);
  if (options.ignoredRelativePaths?.has(relativePath)) return;
  if (!shouldTrackDevServerPath(relativePath)) return;

  const signature = readSignature(absolutePath, options.fileSystem ?? defaultFileSystem);
  if (signature === null) return;
  snapshot.set(relativePath, signature);
}

export function walkDirectory(snapshot, absoluteDirectory, options) {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  if (!fileSystem.existsSync(absoluteDirectory)) return;

  let entries;
  try {
    entries = fileSystem.readdirSync(absoluteDirectory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (options.ignoredDirectoryNames?.has(entry.name)) continue;

    const absolutePath = path.join(absoluteDirectory, entry.name);
    if (entry.isDirectory()) {
      walkDirectory(snapshot, absolutePath, options);
      continue;
    }
    if (entry.isFile() || entry.isSymbolicLink()) {
      addFileToSnapshot(snapshot, absolutePath, options);
    }
  }
}

export function collectWatchedSnapshot(options) {
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const snapshot = new Map();

  for (const absoluteDirectory of options.watchedDirectories) {
    walkDirectory(snapshot, absoluteDirectory, options);
  }
  for (const absoluteFile of options.watchedFiles) {
    if (!fileSystem.existsSync(absoluteFile)) continue;
    addFileToSnapshot(snapshot, absoluteFile, options);
  }

  return snapshot;
}

export function diffSnapshots(previous, next) {
  const changed = new Set();

  for (const [relativePath, signature] of next) {
    if (previous.get(relativePath) !== signature) {
      changed.add(relativePath);
    }
  }
  for (const relativePath of previous.keys()) {
    if (!next.has(relativePath)) {
      changed.add(relativePath);
    }
  }

  return [...changed].sort();
}
