/**
 * tar `--exclude` entries that drop a directory `name` wherever it sits: at the
 * tree root, or nested at any depth. tar matches a pattern against each archive
 * member path, so one literal name is not enough on its own.
 */
export function directoryExcludeEntries(names: readonly string[]): string[] {
  return names.flatMap((name) => [name, `${name}/*`, `*/${name}`, `*/${name}/*`]);
}

/**
 * Directory names a workspace never ships to an execution environment:
 * dependency trees, build output and caches. Every one of them is regenerable
 * at the destination by the install command, every one of them is routinely the
 * bulk of a tree's bytes, and a host-built one is frequently useless there
 * anyway (a macOS `node_modules` carries Mach-O binaries no Linux box can
 * load).
 *
 * One list, used by every staging path — the sandbox transport, the SSH
 * transport and referenced project trees — so a directory dropped on one
 * transport cannot stay shipped on another.
 */
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

/** {@link WORKSPACE_HEAVY_DIR_NAMES} as tar `--exclude` entries. */
export const WORKSPACE_HEAVY_DIR_EXCLUDES = directoryExcludeEntries(WORKSPACE_HEAVY_DIR_NAMES);

/**
 * Escape tar `--exclude` glob metacharacters (`*`, `?`, `[`) in a literal
 * path, so a path that happens to contain one of them is matched literally
 * instead of as a pattern. Without this, a repository-controlled path
 * containing e.g. `*` could exclude unrelated sibling files that happen to
 * match the resulting glob. GNU tar and bsdtar both honor a backslash as an
 * `fnmatch` escape character, so this is not command injection — every
 * `--exclude` value travels as an argument-vector entry, never through a
 * shell.
 *
 * Every literal path that becomes an exclude entry goes through this, whether
 * it came from a referenced project's ignore set or the anchor workspace's.
 * {@link excludePatternMatches} reads the escape back off, so one list of
 * entries can both drive tar and answer "is this path excluded" about the path
 * the entry names.
 */
export function escapeTarExcludeLiteral(entry: string): string {
  return entry.replace(/\\/g, "\\\\").replace(/([*?[])/g, "\\$1");
}

/**
 * Undo {@link escapeTarExcludeLiteral}: a backslash before a character means
 * that character itself, which is tar's own reading of an `--exclude` pattern.
 * The matchers below compare a relative path against an entry, so an escaped
 * entry has to be read back to the path it names. Otherwise an ignored
 * `report[1].csv` arrives here as `report\[1].csv`, matches nothing, and the
 * path tar was told to omit is mistaken for a path the remote deleted.
 *
 * An entry with no backslash is returned unchanged, so the fixed
 * heavy-directory globs pass through untouched.
 */
export function unescapeTarExcludeLiteral(pattern: string): string {
  return pattern.includes("\\") ? pattern.replace(/\\(.)/g, "$1") : pattern;
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
  // Anything that is not one of the directory globs above is a literal path,
  // possibly escaped by `escapeTarExcludeLiteral`. An escaped entry cannot
  // reach the branches above: escaping puts a backslash in front of every `*`,
  // so a literal path never opens with `*/` or closes with `/*`.
  return isRelativePathOrDescendant(relative, unescapeTarExcludeLiteral(pattern));
}

export function shouldExcludePath(relative: string, exclude: readonly string[]): boolean {
  return exclude.some((entry) => excludePatternMatches(relative, entry));
}
