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

// Marks an SSH caller exclude that tar treats as a wildcard (`*.log`).
// Snapshots match marked entries with tar's rules; every other entry keeps the
// plain literal/segment/prefix matching, so Git-ignored names that merely
// contain `*` are never treated as globs. A relative path never starts with
// `//`, so the marker cannot collide with a literal exclude.
export const SSH_GLOB_EXCLUDE_PREFIX = "//glob:";

/** The pattern to hand to tar for an exclude entry. */
export function tarExcludePattern(entry: string): string {
  return entry.startsWith(SSH_GLOB_EXCLUDE_PREFIX) ? entry.slice(SSH_GLOB_EXCLUDE_PREFIX.length) : entry;
}

function excludePatternCore(entry: string): string {
  let core = entry.startsWith("*/") ? entry.slice(2) : entry;
  if (core.endsWith("/*")) core = core.slice(0, -2);
  return core;
}

// tar's --exclude is unanchored: a caller pattern also matches at any depth.
// Literal patterns get a `*/` twin and wildcard patterns are marked, so
// snapshots (shouldExcludePath) skip the same paths the SSH transfer skips; a
// snapshot that keeps a path tar left behind reads as a remote deletion on
// restore. Nested project repositories are synced as their own roots, so they
// get the caller excludes that reach into them, relative to the repository.
export function resolveSshWorkspaceSyncExcludes(input: {
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
}): { workspace: string[]; repository: (repositoryPath: string) => string[] } {
  const heavy = input.workspaceFileMode === "all" ? [] : [...WORKSPACE_HEAVY_DIR_EXCLUDES];
  const callerLiteral: string[] = [];
  const callerGlob: string[] = [];
  for (const entry of input.workspaceExclude ?? []) {
    if (/[*?[]/.test(excludePatternCore(entry))) callerGlob.push(entry);
    else callerLiteral.push(...(entry.startsWith("*/") ? [entry] : [entry, `*/${entry}`]));
  }
  const mark = (entry: string) => `${SSH_GLOB_EXCLUDE_PREFIX}${entry}`;
  return {
    workspace: [...new Set([...heavy, ...callerLiteral, ...callerGlob.map(mark)])],
    repository: (repositoryPath) => [...new Set([
      ...heavy,
      ...callerLiteral.flatMap((entry) =>
        entry.startsWith(`${repositoryPath}/`) ? [entry.slice(repositoryPath.length + 1)]
          : entry.startsWith("*/") ? [entry] : []),
      // tar matches an unanchored glob against any trailing run of path
      // components, so one that does not name this repository still applies
      // inside it unchanged.
      ...callerGlob.map((entry) =>
        mark(entry.startsWith(`${repositoryPath}/`) ? entry.slice(repositoryPath.length + 1) : entry)),
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
  if (pattern.startsWith("//glob:")) {
    // tar --exclude rules: wildcards match `/`, the pattern may start at any
    // component of the member name (`./…`, since the transfer archives `.`),
    // and a matching directory takes its descendants with it. The matcher only
    // ever backtracks to the last `*`, so each check is bounded by pattern
    // length x path length. (The marker is inlined, not imported, because this
    // function is serialized into the workspace-checkpoint worker.)
    const globMatches = (glob: string, subject: string): boolean => {
      const classWidth = (at: number, ch: string): number => {
        let i = at + 1;
        const negate = glob[i] === "!" || glob[i] === "^";
        if (negate) i += 1;
        let hit = false;
        let first = true;
        while (i < glob.length && (first || glob[i] !== "]")) {
          first = false;
          if (glob[i + 1] === "-" && i + 2 < glob.length && glob[i + 2] !== "]") {
            if (ch >= glob[i] && ch <= glob[i + 2]) hit = true;
            i += 3;
          } else {
            if (ch === glob[i]) hit = true;
            i += 1;
          }
        }
        if (i >= glob.length) return ch === "[" ? 1 : -1;
        return hit !== negate ? i + 1 - at : -1;
      };
      let pi = 0;
      let si = 0;
      let star = -1;
      let resume = 0;
      while (si < subject.length) {
        if (pi === glob.length && subject[si] === "/") return true;
        if (pi < glob.length && glob[pi] === "*") {
          star = pi;
          pi += 1;
          resume = si;
          continue;
        }
        const width = pi >= glob.length ? -1
          : glob[pi] === "?" ? 1
            : glob[pi] === "[" ? classWidth(pi, subject[si])
              : glob[pi] === subject[si] ? 1 : -1;
        if (width > 0) {
          pi += width;
          si += 1;
        } else if (star >= 0) {
          pi = star + 1;
          resume += 1;
          si = resume;
        } else {
          return false;
        }
      }
      while (glob[pi] === "*") pi += 1;
      return pi === glob.length;
    };
    const glob = pattern.slice("//glob:".length);
    const name = `./${relative}`;
    return globMatches(glob, name) || globMatches(`*/${glob}`, name);
  }
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
