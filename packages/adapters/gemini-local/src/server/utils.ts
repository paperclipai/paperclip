const BENIGN_STDERR_PATTERNS: readonly RegExp[] = [
  /^YOLO mode is enabled/i,
  /^Failed to fetch admin controls:.*cloudcode-pa\.googleapis\.com/i,
];

function isBenignStderrLine(line: string): boolean {
  return BENIGN_STDERR_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * First non-empty line from `text`, optionally skipping known-benign
 * informational stderr banners (YOLO mode, admin-controls fetch timeout).
 *
 * Pass `skipBenign: true` when processing stderr so benign banners don't
 * surface as error messages. Leave it false (default) when processing
 * stdout or other streams where the patterns could match real content.
 */
export function firstNonEmptyLine(text: string, skipBenign = false): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && (!skipBenign || !isBenignStderrLine(line))) ?? ""
  );
}
