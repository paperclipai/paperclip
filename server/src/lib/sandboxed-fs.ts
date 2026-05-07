import fs from "node:fs/promises";
import path from "node:path";
import { unprocessable } from "../errors.js";

const IGNORED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

export type SandboxedFile = {
  /** Forward-slash path relative to the sandbox root. */
  path: string;
  /** Size in bytes. */
  size: number;
  /** Modification time as ISO-8601 UTC. */
  mtime: string;
};

export type SandboxedFileDetail = SandboxedFile & {
  /** UTF-8 file contents. */
  content: string;
};

/**
 * Normalize a caller-supplied relative path. Rejects empty inputs, absolute paths,
 * and `..` segments before any filesystem access happens. Embedded NUL bytes are
 * also rejected — Node would throw on the FS call anyway, but failing early gives
 * a stable error code.
 */
export function normalizeSandboxRelativePath(candidate: string): string {
  const raw = typeof candidate === "string" ? candidate : "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) === 0) {
      throw unprocessable("Path contains an invalid character");
    }
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw unprocessable("Path must not be empty");
  }
  const normalized = path.posix.normalize(trimmed.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Path must stay within the sandbox root");
  }
  if (path.isAbsolute(normalized)) {
    throw unprocessable("Path must be relative");
  }
  return normalized;
}

/**
 * Lexically resolve `relativePath` under `rootPath`. Rejects anything that escapes
 * the root via `..`. Symlink crossings are caught later by `assertRealPathInside`.
 */
export function resolvePathInSandbox(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeSandboxRelativePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (
    relativeToRoot === ".."
    || relativeToRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToRoot)
  ) {
    throw unprocessable("Path must stay within the sandbox root");
  }
  return absolutePath;
}

/**
 * Resolve `targetPath` and `rootPath` to their real paths and require the result
 * to live inside the (real) root. Defeats symlink-escape attacks where the
 * lexical resolver would have accepted the path.
 */
export async function assertRealPathInside(
  rootPath: string,
  targetPath: string,
): Promise<string> {
  const realRoot = await fs.realpath(rootPath).catch(() => path.resolve(rootPath));
  const realTarget = await fs.realpath(targetPath);
  const relativeToRoot = path.relative(realRoot, realTarget);
  if (
    relativeToRoot === ".."
    || relativeToRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToRoot)
  ) {
    throw unprocessable("Path must stay within the sandbox root");
  }
  return realTarget;
}

function shouldIgnore(entry: { name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink?: () => boolean }): boolean {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isSymbolicLink && entry.isSymbolicLink()) return true;
  if (entry.isDirectory()) return IGNORED_DIRECTORY_NAMES.has(entry.name);
  if (!entry.isFile()) return true;
  return (
    IGNORED_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

/**
 * Recursively list files under `rootPath`. Returns `null` if the root does not
 * exist or is not a directory. Returns `[]` if the root is empty or contains
 * only ignored entries. Symlinks are skipped to keep the sandbox honest.
 */
export async function listSandboxedFilesRecursive(rootPath: string): Promise<SandboxedFile[] | null> {
  const stat = await fs.stat(rootPath).catch(() => null);
  if (!stat?.isDirectory()) return null;
  const out: SandboxedFile[] = [];
  await walk(rootPath, "");
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnore(entry)) continue;
      const childAbsolute = path.join(currentPath, entry.name);
      const childRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(childAbsolute, childRelative);
        continue;
      }
      const fileStat = await fs.stat(childAbsolute).catch(() => null);
      if (!fileStat || !fileStat.isFile()) continue;
      out.push({
        path: childRelative,
        size: fileStat.size,
        mtime: fileStat.mtime.toISOString(),
      });
    }
  }
}

/**
 * Read a single file under `rootPath`, applying the lexical and real-path
 * sandbox checks. Returns `null` if the file does not exist (so callers can
 * map that to a 404 cleanly).
 */
export async function readSandboxedFile(
  rootPath: string,
  relativePath: string,
): Promise<SandboxedFileDetail | null> {
  const lexical = resolvePathInSandbox(rootPath, relativePath);
  const stat = await fs.stat(lexical).catch(() => null);
  if (!stat || !stat.isFile()) return null;
  await assertRealPathInside(rootPath, lexical);
  const content = await fs.readFile(lexical, "utf8");
  return {
    path: normalizeSandboxRelativePath(relativePath),
    size: stat.size,
    mtime: stat.mtime.toISOString(),
    content,
  };
}
