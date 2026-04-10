/**
 * Informational/benign stderr lines emitted by the Gemini CLI that must
 * not be surfaced as error messages. These may be emitted even on
 * successful runs and can hide the real error when the CLI exits
 * non-zero.
 *
 * Patterns are anchored tightly to known-benign prefixes so they do not
 * accidentally suppress a novel error that happens to mention the same
 * tokens (e.g. a real auth failure against cloudcode-pa.googleapis.com).
 */
const BENIGN_STDERR_PATTERNS: readonly RegExp[] = [
  /^YOLO mode is enabled/i,
  /^Failed to fetch admin controls:.*cloudcode-pa\.googleapis\.com/i,
];

function isBenignStderrLine(line: string): boolean {
  return BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Returns the first non-empty line of `text`, skipping known-benign
 * informational stderr lines (see BENIGN_STDERR_PATTERNS).
 *
 * Named `firstNonEmptyLine` for backward compatibility with existing
 * callers; in practice it is "first meaningful line" because benign
 * banners are skipped. Callers that want the literal first non-empty
 * line (including benign banners) should parse `text` directly.
 */
export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !isBenignStderrLine(line)) ?? ""
  );
}
