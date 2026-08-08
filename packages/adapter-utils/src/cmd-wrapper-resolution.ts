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

/**
 * Resolves %VAR%-style environment variable references in a value string.
 * Falls back to the literal %VAR% if the variable is not in env.
 * This is needed because spawn() with shell: false does not expand %VAR%
 * the way cmd.exe would, so patterns like %PATH% in SET commands must be
 * resolved before passing to the spawned process.
 */
export function resolvePercentVars(value: string, env: Record<string, string | undefined>): string {
  // Build a case-insensitive lookup table from env (Windows env vars are
  // case-insensitive, but process.env can expose them as Path or PATH).
  const upperEnv: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    upperEnv[k.toUpperCase()] = v;
  }
  return value.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name) => {
    const resolved = upperEnv[name.toUpperCase()];
    return resolved !== undefined ? resolved : _match;
  });
}

/** Regex patterns for matching executable invocations in .cmd wrappers. */
// Anchored to line start with ^ (multiline) so they only match command
// invocation lines, not variable assignments or mid-line occurrences.
export const DP0_PATTERN_NPM = /^\s*"%dp0%\\(.+?\.exe)"/im;
export const DP0_PATTERN_DIRECT = /^\s*%dp0%\\(.+?\.exe)/im;
export const TILDE_PATTERN_NPM = /^\s*"%~dp0\\(.+?\.exe)"/im;
export const TILDE_PATTERN_DIRECT = /^\s*%~dp0\\(.+?\.exe)/im;
/**
 * Matches SET / @SET assignment lines in .cmd wrappers.
 * Handles: SET KEY=val, SET "KEY=val", @SET KEY=val, @SET "KEY=val"
 * Group 1 = key (no quotes), Group 2 = value (quoted branch),
 * Group 3 = value (unquoted branch).
 */
export const SET_PATTERN = /^\s*@?\s*SET\s+(?:"([A-Za-z_][A-Za-z0-9_]*)=([^"]*)"|([A-Za-z_][A-Za-z0-9_]*)=(.+?))\s*$/gim;

/**
 * Check whether a SET value uses cmd.exe substitution syntax like
 * `%VAR:old=new%` or `%VAR:~offset,len%`. These cannot be resolved with
 * spawn(shell: false), so any wrapper containing them must fall through
 * to cmd.exe.
 */
export function hasCmdSubstitution(value: string): boolean {
  // Match %VAR:... patterns (substitution, substring) that only cmd.exe can expand
  return /%[A-Za-z_][A-Za-z0-9_]*[:~]/.test(value);
}

/**
 * Parse a .cmd wrapper file's content to extract the real executable
 * (relative path) and any SET-based environment variable overrides.
 *
 * Skips SET assignment lines when matching exe paths to avoid false positives
 * from variable assignments like `SET "NODE_EXE=%~dp0\node.exe"`.
 * Skips SET assignments for "dp0" in envOverrides (ephemeral, not useful).
 *
 * If any SET value contains cmd.exe-only substitution syntax (%VAR:...=...%
 * or %VAR:~...%), returns exeRelativePath: null to force fallback to cmd.exe.
 */
export function parseCmdWrapperContent(content: string, baseEnv?: Record<string, string | undefined>): {
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
    // Groups depend on which alternation branch matched:
    //   Branch 1 (quoted "KEY=***"): setMatch[1] = key, setMatch[2] = value
    //   Branch 2 (unquoted KEY=***): setMatch[3] = key, setMatch[4] = value
    const key = setMatch[1] ?? setMatch[3];
    const value = (setMatch[2] ?? setMatch[4] ?? "").trim();
    if (key.toLowerCase() !== "dp0") {
      // If any SET value uses cmd.exe-only substitution syntax, we cannot
      // safely resolve this wrapper with shell: false. Signal the caller
      // to fall through to cmd.exe by returning exeRelativePath: null.
      if (hasCmdSubstitution(value)) {
        return { exeRelativePath: null, envOverrides: {} };
      }
      // Process SETs sequentially: expand %VAR% against accumulated overrides
      // (simulating cmd.exe's sequential SET behavior where later assignments
      // can reference earlier ones, e.g. SET A=x + SET B=%A% → B=x)
      const expanded = resolvePercentVars(value, { ...baseEnv, ...envOverrides });
      envOverrides[key] = expanded;
    }
  }

  return {
    exeRelativePath: exeMatch ? exeMatch[1] : null,
    envOverrides,
  };
}
