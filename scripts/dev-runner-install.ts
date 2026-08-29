import { existsSync, rmSync, statSync, utimesSync } from "node:fs";
import path from "node:path";

export interface StaleInstallCheck {
  stale: boolean;
  reason: string | null;
}

function mtimeMs(filePath: string): number | null {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function modulesManifestPath(repoRoot: string): string {
  return path.join(repoRoot, "node_modules", ".modules.yaml");
}

export function lockfilePath(repoRoot: string): string {
  return path.join(repoRoot, "pnpm-lock.yaml");
}

// pnpm rewrites node_modules/.modules.yaml at the end of every install, so a
// lockfile newer than that manifest means the checkout picked up dependency
// changes (e.g. a pull) that were never installed.
export function detectStaleInstall(repoRoot: string): StaleInstallCheck {
  const lockfileMtime = mtimeMs(lockfilePath(repoRoot));
  if (lockfileMtime === null) {
    return { stale: false, reason: null };
  }
  const manifestMtime = mtimeMs(modulesManifestPath(repoRoot));
  if (manifestMtime === null) {
    return { stale: true, reason: "dependencies have never been installed in this checkout" };
  }
  if (lockfileMtime > manifestMtime) {
    return { stale: true, reason: "pnpm-lock.yaml changed after the last pnpm install" };
  }
  return { stale: false, reason: null };
}

// The manifest mtime is the staleness marker, but a no-op install may skip
// rewriting it; bump it explicitly so a touched-but-unchanged lockfile cannot
// re-trigger installs forever.
export function markInstallFresh(repoRoot: string, now = new Date()): void {
  try {
    utimesSync(modulesManifestPath(repoRoot), now, now);
  } catch {
    // Manifest missing (unusual pnpm setup): the next boot re-runs a no-op install.
  }
}

export function resolveViteCachePaths(repoRoot: string): string[] {
  return [
    path.join(repoRoot, "ui", "node_modules", ".vite"),
    path.join(repoRoot, "node_modules", ".vite"),
  ];
}

// Vite's optimizer keeps serving pre-bundled deps hashed against the old
// lockfile ("504 Outdated Optimize Dep") — drop the caches after an install so
// the next server boot re-bundles.
export function clearViteCaches(repoRoot: string): string[] {
  const removed: string[] = [];
  for (const cachePath of resolveViteCachePaths(repoRoot)) {
    if (!existsSync(cachePath)) continue;
    rmSync(cachePath, { recursive: true, force: true });
    removed.push(cachePath);
  }
  return removed;
}
