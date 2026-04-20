import path from "node:path";

/**
 * Resolves a path against cwd and enforces that it stays within cwd OR within
 * one of the optional allowedWriteRoots. This lets operators explicitly permit
 * additional write locations (e.g. an Obsidian vault on an external volume)
 * without dropping the sandbox entirely.
 */
export function safePath(
  cwd: string,
  relativePath: string,
  allowedWriteRoots: string[] = [],
): string {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, relativePath);

  if (resolved === resolvedCwd || resolved.startsWith(resolvedCwd + path.sep)) {
    return resolved;
  }

  for (const root of allowedWriteRoots) {
    const resolvedRoot = path.resolve(root);
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
      return resolved;
    }
  }

  throw new Error(`Path traversal blocked: ${relativePath}`);
}
