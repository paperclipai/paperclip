/**
 * Parse Kiro CLI output.
 *
 * --wrap never only controls line wrapping; ANSI color codes are still emitted.
 * stripAnsi is the primary parse operation, not a fallback.
 *
 * Credit info is reported in stderr: "Credits: X.XX • Time: Xs"
 */

/**
 * Comprehensive ANSI escape code regex covering:
 * - CSI sequences: \x1b[0m, \x1b[31m, \x1b[2K, \x1b[?25l, etc.
 * - OSC sequences: \x1b]0;Title\x07 (terminated by BEL or ST)
 */
const ANSI_RE = /\x1b(?:\[\??[0-9;]*[a-zA-Z]|\][0-9];[^\x07\x1b]*[\x07\x1b\\])/g;

/**
 * Strip all ANSI escape codes from text.
 * This is mandatory for kiro-cli output — --wrap never does NOT remove color codes.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Extract credit value from stderr.
 * Kiro reports: "Credits: 0.04 • Time: 1s"
 */
export function parseCredits(stderr: string): number | null {
  if (!stderr) return null;
  const match = stderr.match(/credits:\s*([0-9,]+\.?[0-9]*)/i);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ""));
  return isNaN(value) ? null : value;
}

/**
 * Extract time in seconds from stderr.
 * Kiro reports: "Credits: 0.04 • Time: 1s"
 */
export function parseTimeSeconds(stderr: string): number | null {
  if (!stderr) return null;
  const match = stderr.match(/time:\s*([0-9,]+\.?[0-9]*)s/i);
  if (!match) return null;
  const value = parseFloat(match[1].replace(/,/g, ""));
  return isNaN(value) ? null : value;
}

/**
 * Parse kiro stdout and stderr into a structured result.
 */
export function parseKiroOutput(
  stdout: string,
  stderr: string,
): { summary: string; costUsd: number | null; timeSeconds: number | null } {
  return {
    summary: stripAnsi(stdout).trim(),
    costUsd: parseCredits(stderr),
    timeSeconds: parseTimeSeconds(stderr),
  };
}

/**
 * Check if output indicates an unknown/expired session error.
 * Used to decide whether to retry without --resume.
 */
export function isKiroUnknownSessionError(stdout: string, stderr: string): boolean {
  const combined = stripAnsi((stdout + " " + stderr).toLowerCase());
  return (
    combined.includes("unknown session") ||
    (combined.includes("session") && combined.includes("not found")) ||
    combined.includes("unknown chat") ||
    (combined.includes("chat") && combined.includes("not found")) ||
    combined.includes("resume not found") ||
    combined.includes("resume session not found") ||
    combined.includes("could not resume")
  );
}
