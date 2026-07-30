/**
 * Shared parser for .cmd wrapper resolution.
 *
 * On Windows, spawning .cmd files via cmd.exe creates visible console windows.
 * This module extracts the real executable path and SET-based env overrides
 * from npm-style .cmd wrappers so callers can spawn the exe directly.
 *
 * The parser filters out SET assignment lines before matching exe paths to
 * avoid false positives from patterns like:
 *   SET "NODE_EXE=%~dp0\node.exe"
 * which look like exe invocations but are just variable assignments.
 */

/** Regex patterns for matching executable invocations in .cmd wrappers. */
export const DP0_PATTERN_NPM = /"%dp0%\\(.+?\.exe)"/i;
export const DP0_PATTERN_DIRECT = /%dp0%\\(.+?\.exe)/i;
export const TILDE_PATTERN_NPM = /"%~dp0\\(.+?\.exe)"/i;
export const TILDE_PATTERN_DIRECT = /%~dp0\\(.+?\.exe)/i;
export const SET_PATTERN = /^\s*@?\s*SET\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.+?)"?\s*$/gim;

/**
 * Parse a .cmd wrapper file's content to extract the real executable
 * (relative path) and any SET-based environment variable overrides.
 *
 * Skips SET assignment lines when matching exe paths to avoid false positives
 * from variable assignments like `SET "NODE_EXE=%~dp0\node.exe"`.
 * Skips SET assignments for "dp0" in envOverrides (ephemeral, not useful).
 *
 * Security: the returned exeRelativePath must be validated by the caller via
 * isSafeResolvedExe() before use to prevent path traversal attacks where a
 * malicious .cmd file embeds `..\..\..\windows\system32\cmd.exe`-style paths.
 */
export function parseCmdWrapperContent(content: string): {
  exeRelativePath: string | null;
  envOverrides: Record<string, string>;
} {
  // Filter out SET assignment lines before matching exe paths.
  // Without this, patterns like SET "NODE_EXE=%~dp0\node.exe" would
  // incorrectly match and return "node.exe" as the resolved executable.
  const invocationLines = content
    .split(/\r?\n/)
    .filter((line) => !/^\s*@?\s*SET\s+/i.test(line))
    .join("\n");

  const exeMatch =
    invocationLines.match(DP0_PATTERN_NPM) ??
    invocationLines.match(DP0_PATTERN_DIRECT) ??
    invocationLines.match(TILDE_PATTERN_NPM) ??
    invocationLines.match(TILDE_PATTERN_DIRECT);

  const envOverrides: Record<string, string> = {};
  let setMatch;
  const setRegex = new RegExp(SET_PATTERN.source, SET_PATTERN.flags);
  while ((setMatch = setRegex.exec(content)) !== null) {
    const key = setMatch[1];
    if (key.toLowerCase() !== "dp0") {
      envOverrides[key] = setMatch[2].trim();
    }
  }

  return {
    exeRelativePath: exeMatch ? exeMatch[1] : null,
    envOverrides,
  };
}

/**
 * Validate that a resolved executable path does not escape the expected base
 * directory. Guards against path traversal in .cmd wrapper content where a
 * malicious wrapper could embed `..\..\windows\system32\evil.exe`.
 *
 * @param resolvedExe  Absolute path returned by path.resolve(dir, exeRelativePath)
 * @param expectedDir  The directory the .cmd file lives in (path.dirname(cmdPath))
 * @returns true only if resolvedExe is strictly inside expectedDir
 */
export function isSafeResolvedExe(
  resolvedExe: string,
  expectedDir: string,
): boolean {
  // Normalise to forward-slashes and ensure expectedDir has a trailing sep so
  // that a sibling like `/foo/bar-evil` does not pass the startsWith check
  // against `/foo/bar`.
  const sep = "/";
  const norm = (p: string) => p.replace(/\\/g, sep).replace(/\/$/, "");
  const safeDir = norm(expectedDir) + sep;
  const candidate = norm(resolvedExe);
  return candidate.startsWith(safeDir);
}
