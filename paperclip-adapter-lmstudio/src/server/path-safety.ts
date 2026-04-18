import path from "node:path";

export function safePath(cwd: string, relativePath: string): string {
  const resolvedCwd = path.resolve(cwd);
  const resolved = path.resolve(resolvedCwd, relativePath);
  if (!resolved.startsWith(resolvedCwd + path.sep) && resolved !== resolvedCwd) {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  return resolved;
}
