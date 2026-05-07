/**
 * Map a working directory to the slug Claude Code uses for its project memory
 * folder under `~/.claude/projects/<slug>/`.
 *
 * Observed convention (Claude Code as of 2026-05): every character that is not
 * an alphanumeric or `-` is replaced with `-`. Hyphens already present in the
 * cwd are preserved. The leading slash on POSIX paths therefore becomes a
 * leading `-`, and consecutive non-alphanumerics produce consecutive `-`s
 * (they are not collapsed).
 *
 * Example:
 *   `/Users/jane/.paperclip/instances/default/projects/foo/_default`
 *     -> `-Users-jane--paperclip-instances-default-projects-foo--default`
 *
 * Keep this helper as the single source of truth so we can swap conventions if
 * Claude Code ever changes them.
 */
export function slugifyClaudeCodeProjectCwd(cwd: string): string {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  return cwd.replace(/[^a-zA-Z0-9-]/g, "-");
}
