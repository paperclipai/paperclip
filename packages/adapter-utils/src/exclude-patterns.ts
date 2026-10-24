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

/**
 * Directories where agents keep nested git worktrees. They are multi-gigabyte,
 * always rebuildable from the repository, and uploading them (or pulling them
 * back) is what exhausts the staging volume during an SSH workspace sync.
 */
export const NESTED_WORKTREE_DIRS: readonly string[] = [".paperclip/worktrees", ".claude/worktrees"];

/**
 * Expands directory paths into exclude patterns that match the directory and
 * everything under it, at the workspace root and at any depth. `tar --exclude`
 * is unanchored, so the same patterns must also drive the restore baseline
 * (`shouldExcludePath`) or the merge would treat an excluded directory as
 * deleted on the remote.
 */
export function directoryExcludePatterns(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) => [dir, `${dir}/*`, `*/${dir}`, `*/${dir}/*`]);
}

/**
 * Normalizes caller-supplied directories to plain relative posix paths. `tar`
 * globs and unanchors its patterns while `shouldExcludePath` matches literally,
 * so anything that is not a plain path would be excluded by one and not the
 * other and the restore would delete local files.
 */
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

/**
 * The nested worktree directories to leave out of an SSH workspace sync.
 * `nestedWorktreeDirs` replaces the default list (an empty list disables the
 * excludes). Plain `workspaceFileMode: "all"` directories sync every file
 * unless a list is given explicitly.
 */
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
