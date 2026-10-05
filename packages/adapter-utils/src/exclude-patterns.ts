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
