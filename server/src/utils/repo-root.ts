import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Cached so repeated calls (e.g. on every skill import) don't hit the filesystem each time.
let _repoRoot: string | null = null;

/**
 * Walks up from this file's directory to find the monorepo root.
 *
 * Why not process.cwd()?
 * When the server runs via `pnpm run dev` from the server/ subdirectory,
 * process.cwd() returns .../server, not the repo root. Any path resolved
 * against process.cwd() would be wrong on all machines and break cross-machine
 * portability of paths stored in the shared Azure DB.
 *
 * Why pnpm-workspace.yaml?
 * This repo uses pnpm workspaces configured via pnpm-workspace.yaml, NOT the
 * "workspaces" key in package.json (npm/yarn style). The original code only
 * checked package.json so it never found the root and silently fell back to
 * process.cwd(), causing absolute machine-specific paths to be stored in DB.
 */
export function resolveRepoRoot(): string {
  if (_repoRoot) return _repoRoot;
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;
  for (let i = 0; i < 8; i++) {
    // pnpm monorepo marker (this repo uses pnpm workspaces)
    try {
      readFileSync(path.join(dir, "pnpm-workspace.yaml"), "utf8");
      _repoRoot = dir;
      return dir;
    } catch {}
    // npm/yarn monorepo fallback
    try {
      const content = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (content.workspaces) {
        _repoRoot = dir;
        return dir;
      }
    } catch {}
    dir = path.dirname(dir);
  }
  // Last resort — should never reach here in normal operation
  _repoRoot = process.cwd();
  return _repoRoot;
}

/**
 * Strips the repo root prefix from an absolute path so it can be stored
 * portably in the shared DB. On any other machine, resolveFromRepoRoot()
 * reconstructs the correct absolute path.
 *
 * e.g. /Users/karthikkhatavkar/medicodio-paperclip/skills/outlook → skills/outlook
 */
export function toRelativeIfPossible(absPath: string): string {
  const root = resolveRepoRoot();
  const prefix = root + path.sep;
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath;
}

/**
 * Converts a relative path (from DB) back to an absolute path for runtime use.
 * Absolute paths pass through unchanged — safe to call unconditionally.
 *
 * e.g. skills/outlook → /Users/murali/medicodio-paperclip/skills/outlook
 */
export function resolveFromRepoRoot(relativePath: string): string {
  return path.isAbsolute(relativePath)
    ? relativePath
    : path.resolve(resolveRepoRoot(), relativePath);
}
