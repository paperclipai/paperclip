/**
 * Portable path normalization utilities.
 *
 * Used by company-portability and company-skills to canonicalize file paths
 * inside portable company packages (backslash → forward-slash, resolve `.`
 * and `..`, strip leading `./` or `/`).
 */

import path from "node:path";

/**
 * Normalize a portable file path to a canonical forward-slash form.
 *
 * - Converts backslashes to forward slashes
 * - Strips leading `./` and `/`
 * - Resolves `.` and `..` segments
 * - Returns an empty string for root / empty input
 */
export function normalizePortablePath(input: string): string {
  const parts: string[] = [];
  const normalized = input
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "");
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join("/");
}

/**
 * Resolve a relative `targetPath` against the directory of `fromPath`,
 * returning a normalized portable path.
 */
export function resolvePortablePath(fromPath: string, targetPath: string): string {
  const baseDir = path.posix.dirname(fromPath.replace(/\\/g, "/"));
  return normalizePortablePath(path.posix.join(baseDir, targetPath.replace(/\\/g, "/")));
}
