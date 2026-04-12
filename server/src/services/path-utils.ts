/**
 * Portable home-directory rebasing for workspace paths.
 *
 * Problem: absolute paths like `/Users/bright/Projects/foo` are stored
 * in the DB (project_workspaces.cwd, agent_sessions.workspace_path).
 * When the same DB is used on a different machine or user account
 * (e.g. `/Users/bbright/`), every fs.mkdir / spawn({ cwd }) fails with
 * "Could not create folder".
 *
 * Solution: detect the home-directory prefix in stored paths and rebase
 * it to `os.homedir()` at read time. This is applied at the two source
 * functions that resolve workspace paths from the DB:
 *   - resolveWorkspacePath()  in agent-sessions.ts
 *   - normalizeWorkspaceCwd() in projects.ts
 *
 * Supported platforms:
 *   - macOS:  /Users/<username>/...
 *   - Linux:  /home/<username>/...
 *   - Both:   ~/... (already resolved by the caller)
 */

import os from "node:os";

/**
 * Pattern that matches the home-directory prefix on macOS (/Users/X/)
 * and Linux (/home/X/). Captures everything up to and including the
 * username segment so it can be replaced with the current homedir.
 */
const HOME_PREFIX_RE = /^\/(?:Users|home)\/[^/]+/;

/**
 * Rebase an absolute path's home-directory prefix to the current
 * machine's `os.homedir()`. Returns the path unchanged if it does not
 * start with a recognizable home prefix, or if it already matches.
 *
 * Examples:
 *   rebaseHomePath("/Users/bright/Projects/foo")
 *     → "/Users/bbright/Projects/foo"   (on a bbright machine)
 *
 *   rebaseHomePath("/opt/data/shared")
 *     → "/opt/data/shared"              (no home prefix — unchanged)
 *
 *   rebaseHomePath("/Users/bbright/Projects/foo")
 *     → "/Users/bbright/Projects/foo"   (already correct — unchanged)
 */
export function rebaseHomePath(p: string): string {
  const match = p.match(HOME_PREFIX_RE);
  if (!match) return p;
  const currentHome = os.homedir();
  if (match[0] === currentHome) return p; // already correct
  return p.replace(match[0], currentHome);
}
