import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_FILE_SIZE = 1_048_576; // 1 MB
const MAX_LISTING_ENTRIES = 1000;
const BINARY_CHECK_BYTES = 8192; // 8 KB
const EXCLUDED_DIRS: ReadonlySet<string> = new Set([".git"]);

// ---------------------------------------------------------------------------
// Path sandboxing
// ---------------------------------------------------------------------------

/**
 * Resolve `requestedPath` against `workspaceRoot` and assert the result stays
 * inside the workspace.  Rejects null bytes and leading-slash escapes.
 */
export function resolveAndSandbox(workspaceRoot: string, requestedPath: string): string {
  if (requestedPath.includes("\0")) {
    throw Object.assign(new Error("Path contains null bytes"), { code: "BAD_PATH" });
  }
  const normalized = requestedPath.replace(/^\/+/, "");
  const resolved = path.resolve(workspaceRoot, normalized);
  if (resolved !== workspaceRoot && !resolved.startsWith(workspaceRoot + path.sep)) {
    throw Object.assign(new Error("Path escapes workspace root"), { code: "BAD_PATH" });
  }
  return resolved;
}

/**
 * Same as `resolveAndSandbox` but additionally follows symlinks via
 * `fs.realpath` to prevent symlink-based escapes.
 *
 * For paths that do not yet exist (write targets) we walk up to the nearest
 * existing ancestor and verify *that* is inside the workspace.
 */
async function resolveAndSandboxReal(workspaceRoot: string, requestedPath: string): Promise<string> {
  const resolved = resolveAndSandbox(workspaceRoot, requestedPath);
  const realRoot = await fs.realpath(workspaceRoot);

  try {
    const realResolved = await fs.realpath(resolved);
    if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) {
      throw Object.assign(new Error("Path escapes workspace root via symlink"), { code: "BAD_PATH" });
    }
    return resolved;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      // File does not exist yet — verify the nearest existing ancestor.
      let ancestor = path.dirname(resolved);
      while (ancestor !== path.dirname(ancestor)) {
        try {
          const realAncestor = await fs.realpath(ancestor);
          if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
            throw Object.assign(new Error("Path escapes workspace root via symlink"), { code: "BAD_PATH" });
          }
          return resolved;
        } catch (innerErr: unknown) {
          if ((innerErr as NodeJS.ErrnoException).code === "ENOENT") {
            ancestor = path.dirname(ancestor);
            continue;
          }
          throw innerErr;
        }
      }
      return resolved;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

function isBinaryBuffer(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

/**
 * List directory contents up to `depth` levels deep.
 * Excludes `.git` directories.  Caps output at 1 000 entries.
 */
export async function listFiles(
  workspaceRoot: string,
  requestedPath: string,
  depth: number = 1,
): Promise<FileEntry[]> {
  const resolved = await resolveAndSandboxReal(workspaceRoot, requestedPath);
  const entries: FileEntry[] = [];

  async function walk(dir: string, currentDepth: number) {
    if (currentDepth > depth || entries.length >= MAX_LISTING_ENTRIES) return;

    let dirEntries: import("node:fs").Dirent[];
    try {
      dirEntries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of dirEntries) {
      if (entries.length >= MAX_LISTING_ENTRIES) break;
      if (EXCLUDED_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(workspaceRoot, fullPath);

      if (entry.isDirectory()) {
        entries.push({ name: entry.name, path: relativePath, type: "directory" });
        if (currentDepth < depth) {
          await walk(fullPath, currentDepth + 1);
        }
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          entries.push({ name: entry.name, path: relativePath, type: "file", size: stat.size });
        } catch {
          // skip files we can't stat (permissions, etc.)
        }
      }
    }
  }

  await walk(resolved, 1);
  return entries;
}

/**
 * Read a text file from the workspace.
 * Rejects binary files (422) and files > 1 MB (413).
 */
export async function readFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<{ content: string; size: number; path: string }> {
  const resolved = await resolveAndSandboxReal(workspaceRoot, requestedPath);

  let stat: import("node:fs").Stats;
  try {
    stat = await fs.stat(resolved);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw Object.assign(new Error("File not found"), { code: "NOT_FOUND" });
    }
    throw err;
  }

  if (!stat.isFile()) {
    throw Object.assign(new Error("Path is not a file"), { code: "NOT_FILE" });
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw Object.assign(new Error(`File exceeds ${MAX_FILE_SIZE} byte limit`), { code: "TOO_LARGE" });
  }

  const buffer = await fs.readFile(resolved);
  if (isBinaryBuffer(buffer)) {
    throw Object.assign(new Error("File appears to be binary"), { code: "BINARY" });
  }

  return {
    content: buffer.toString("utf-8"),
    size: stat.size,
    path: path.relative(workspaceRoot, resolved),
  };
}

/**
 * Write a UTF-8 text file into the workspace, creating parent directories as
 * needed.  Rejects content > 1 MB (413).
 */
export async function writeFile(
  workspaceRoot: string,
  requestedPath: string,
  contents: string,
): Promise<{ path: string; size: number }> {
  const resolved = await resolveAndSandboxReal(workspaceRoot, requestedPath);

  const buf = Buffer.from(contents, "utf-8");
  if (buf.length > MAX_FILE_SIZE) {
    throw Object.assign(new Error(`Content exceeds ${MAX_FILE_SIZE} byte limit`), { code: "TOO_LARGE" });
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, buf);

  return {
    path: path.relative(workspaceRoot, resolved),
    size: buf.length,
  };
}
