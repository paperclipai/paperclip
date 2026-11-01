export function isRelativePathOrDescendant(relative: string, candidate: string): boolean {
  return relative === candidate || relative.startsWith(`${candidate}/`);
}

function pathContainsSegmentOrDescendant(relative: string, segment: string): boolean {
  return relative === segment ||
    relative.startsWith(`${segment}/`) ||
    relative.endsWith(`/${segment}`) ||
    relative.includes(`/${segment}/`);
}

export function excludePatternMatches(relative: string, pattern: string): boolean {
  if (pattern.startsWith("*/") && pattern.endsWith("/*")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2, -2));
  }
  if (pattern.startsWith("*/")) {
    return pathContainsSegmentOrDescendant(relative, pattern.slice(2));
  }
  if (pattern.endsWith("/*")) {
    const base = pattern.slice(0, -2);
    return relative.startsWith(`${base}/`);
  }
  return isRelativePathOrDescendant(relative, pattern);
}

export function shouldExcludePath(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => excludePatternMatches(relative, entry));
}

export const NESTED_WORKTREE_DIRS: readonly string[] = [".paperclip/worktrees", ".claude/worktrees"];

export function directoryExcludePatterns(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) => [dir, `${dir}/*`, `*/${dir}`, `*/${dir}/*`]);
}

function normalizeNestedWorktreeDir(value: string): string {
  const normalized = value.replace(/^(?:\.?\/)+/, "").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized === "." ||
    /[*?[\]\\]/.test(normalized) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid nested worktree directory: ${JSON.stringify(value)}. Use a relative path such as ".claude/worktrees".`);
  }
  return normalized;
}

export function resolveNestedWorktreeDirs(input: {
  workspaceFileMode?: "all";
  nestedWorktreeDirs?: readonly string[];
}): string[] {
  if (input.nestedWorktreeDirs) return [...new Set(input.nestedWorktreeDirs.map(normalizeNestedWorktreeDir))];
  return input.workspaceFileMode === "all" ? [] : [...NESTED_WORKTREE_DIRS];
}

export function resolveNestedWorktreeExcludes(input: {
  workspaceFileMode?: "all";
  nestedWorktreeDirs?: readonly string[];
}): string[] {
  return directoryExcludePatterns(resolveNestedWorktreeDirs(input));
}
