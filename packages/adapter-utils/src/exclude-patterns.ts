export const WORKSPACE_HEAVY_DIR_NAMES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
] as const;

export const WORKSPACE_HEAVY_DIR_EXCLUDES = WORKSPACE_HEAVY_DIR_NAMES.flatMap((entry) => [
  entry,
  `${entry}/*`,
  `*/${entry}`,
  `*/${entry}/*`,
]);

// tar's --exclude is unanchored: a caller pattern also matches at any depth.
// Each one gets a `*/` twin so snapshots (shouldExcludePath) skip the same
// paths the SSH transfer skips; a snapshot that keeps a path tar left behind
// reads as a remote deletion on restore. Nested project repositories are
// synced as their own roots, so they get the caller excludes that reach into
// them, relative to the repository.
export function resolveSshWorkspaceSyncExcludes(input: {
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
}): { workspace: string[]; repository: (repositoryPath: string) => string[] } {
  const heavy = input.workspaceFileMode === "all" ? [] : [...WORKSPACE_HEAVY_DIR_EXCLUDES];
  const caller = (input.workspaceExclude ?? []).flatMap((entry) =>
    entry.startsWith("*/") ? [entry] : [entry, `*/${entry}`]);
  return {
    workspace: [...new Set([...heavy, ...caller])],
    repository: (repositoryPath) => [...new Set([
      ...heavy,
      ...caller.flatMap((entry) =>
        entry.startsWith(`${repositoryPath}/`) ? [entry.slice(repositoryPath.length + 1)]
          : entry.startsWith("*/") ? [entry] : []),
    ])],
  };
}

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
  let core = pattern;
  let matched: boolean;
  if (pattern.startsWith("*/") && pattern.endsWith("/*")) {
    core = pattern.slice(2, -2);
    matched = pathContainsSegmentOrDescendant(relative, core);
  } else if (pattern.startsWith("*/")) {
    core = pattern.slice(2);
    matched = pathContainsSegmentOrDescendant(relative, core);
  } else if (pattern.endsWith("/*")) {
    core = pattern.slice(0, -2);
    matched = relative.startsWith(`${core}/`);
  } else {
    matched = isRelativePathOrDescendant(relative, pattern);
  }
  if (matched || !/[*?[]/.test(core)) return matched;
  // A wildcard pattern (`*.log`) follows tar's --exclude rules, since tar is
  // what skips it on the SSH transfer: unanchored, wildcards match `/`, and a
  // matching directory takes its descendants with it. Member names are `./…`
  // because the transfer archives `.`.
  const glob = pattern
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\[!/g, "[^")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^(?:.*/)?${glob}(?:/.*)?$`).test(`./${relative}`);
  } catch {
    return false;
  }
}

export function shouldExcludePath(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => excludePatternMatches(relative, entry));
}
