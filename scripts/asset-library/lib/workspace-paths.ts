// Workspace-path detection for issue descriptions.
// Powers the GLA-1102 red banner + auto-resolve flow: agents that reference
// `_default/.planning/...` paths in markdown bodies leak agent-private
// surfaces; humans can't open them. We detect those mentions and offer
// auto-promote-to-IssueDocument.

const PATH_TERMINATOR = "[^\\s)\\]\"'<>|`,;]+";

const PATTERNS: RegExp[] = [
  // Absolute paperclip-worktree path
  new RegExp(`\\/Users\\/[\\w.-]+\\/\\.paperclip-worktrees\\/${PATH_TERMINATOR}`, "g"),
  // Relative agent-workspace prefixes
  new RegExp(`(?<![A-Za-z0-9_/-])(?:\\.planning|_default|produced)\\/${PATH_TERMINATOR}`, "g"),
  // workspaces/<uuid>/...
  new RegExp(`(?<![A-Za-z0-9_/-])workspaces\\/[a-z0-9-]{36}\\/${PATH_TERMINATOR}`, "g"),
];

export function hasWorkspacePaths(description: string | null | undefined): boolean {
  if (!description) return false;
  return PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(description);
  });
}

export function extractWorkspacePaths(description: string | null | undefined): string[] {
  if (!description) return [];
  const found = new Set<string>();
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(description)) !== null) {
      found.add(m[0]);
    }
  }
  return Array.from(found);
}
