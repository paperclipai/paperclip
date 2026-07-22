import { execFileSync } from "node:child_process";

/**
 * The commit the running server's working tree is checked out at.
 *
 * The server runs under `tsx watch` from its serving tree, so `process.cwd()`
 * is inside that tree and its HEAD is the commit whose bytes are executing.
 *
 * LOOA-382 found that health cannot prove *which instance* a server attached to
 * -- an empty instance answers `200 / status:ok` identically. It can, however,
 * prove *which commit* it is running, because that is a fact the deploy writes
 * to disk (the tree's HEAD), not a field the server declares about itself.
 * Exposing it turns "is the serving tree stale?" (LOOA-389) from something you
 * infer into something you can read: compare this SHA against `master`.
 *
 * A short TTL cache keeps health cheap without going stale across a deploy: a
 * `deploy:live` fast-forward that changes watched files makes `tsx watch`
 * reload, but a fast-forward that only touches unwatched files would not, so we
 * re-read rather than caching for the whole process lifetime. Best-effort: a
 * server run outside a git checkout (a packaged release) simply reports null.
 *
 * Mirrors `scripts/live-service.mjs`'s `resolveServingCommit`, which cannot be
 * imported here (it is kept dependency-free for git hooks).
 */
export type ServingCommit = { head: string; branch: string };

const TTL_MS = 5_000;
let cache: { at: number; value: ServingCommit | null } | null = null;

function readServingCommit(cwd: string): ServingCommit | null {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!head) return null;
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { head, branch: branch || "HEAD" };
  } catch {
    return null;
  }
}

export function resolveServingCommit(
  cwd: string = process.cwd(),
  now: number = Date.now(),
): ServingCommit | null {
  if (cache && now - cache.at < TTL_MS) return cache.value;
  const value = readServingCommit(cwd);
  cache = { at: now, value };
  return value;
}

/** Test-only: drop the cache so a test can observe a fresh read. */
export function __resetServingCommitCacheForTests() {
  cache = null;
}
