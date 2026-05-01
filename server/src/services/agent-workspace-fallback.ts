import { asString, parseObject } from "../adapters/utils.js";

/**
 * Resolves a workspace fallback from `agent.adapterConfig.cwd` for runs that
 * have no project workspace and no prior session cwd.
 *
 * Without this fallback, agents hired with an explicit `cwd` (typically a real
 * git repo intended for `git_worktree` provisioning) silently land in the
 * per-agent home dir (`~/.paperclip/instances/.../agents/<id>/_default/`) and
 * fail with `fatal: not a git repository`. Upstream issue #4946.
 *
 * Pure function so it can be unit-tested without embedded-Postgres or live FS.
 *
 * @param input.adapterConfig — raw agent.adapterConfig (may be unknown shape).
 * @param input.dirExists     — async predicate; production callers wire this
 *                              to `fs.stat(cwd).then(s => s.isDirectory())`.
 * @returns The configured cwd if it exists on disk and is a directory,
 *          otherwise null. Callers fall back to the per-agent home dir on null.
 */
export async function resolveAgentConfigCwdFallback(input: {
  adapterConfig: unknown;
  dirExists: (path: string) => Promise<boolean>;
}): Promise<{ cwd: string } | null> {
  const config = parseObject(input.adapterConfig);
  const cwd = asString(config.cwd, "");
  if (!cwd) return null;

  const exists = await input.dirExists(cwd);
  if (!exists) return null;

  return { cwd };
}
