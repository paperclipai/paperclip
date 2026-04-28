const BENIGN_STDERR_PATTERNS: readonly RegExp[] = [
  /^YOLO mode is enabled/i,
  /^Failed to fetch admin controls:.*cloudcode-pa\.googleapis\.com/i,
];

function isBenignStderrLine(line: string): boolean {
  return BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * First non-empty, non-benign line from `text`. Skips known-benign
 * informational stderr banners so they don't surface as error messages.
 */
export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !isBenignStderrLine(line)) ?? ""
  );
}
