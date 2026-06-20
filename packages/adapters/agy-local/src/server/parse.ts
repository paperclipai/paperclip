export interface AgyParseResult {
  finalMessage: string | null;
  errors: string[];
}

/**
 * Parse agy --print stdout.
 * agy outputs plain text, not NDJSON, so this is a straightforward trim.
 */
export function parseAgyOutput(stdout: string): AgyParseResult {
  const trimmed = stdout.trim();
  return {
    finalMessage: trimmed.length > 0 ? trimmed : null,
    errors: [],
  };
}

/**
 * Detect authentication errors in agy stdout/stderr.
 */
export function detectAgyAuthRequired(stdout: string, stderr: string): boolean {
  const combined = `${stdout}\n${stderr}`.toLowerCase();
  return (
    combined.includes("not logged into antigravity") ||
    combined.includes("you are not signed in") ||
    combined.includes("authentication required") ||
    combined.includes("error getting token source") ||
    combined.includes("agy auth login")
  );
}
