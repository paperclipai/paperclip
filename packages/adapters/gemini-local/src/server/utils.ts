export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

// Informational lines that the Gemini CLI emits to stderr in approval-mode=yolo
// even on a healthy run. They are not error signals and must not surface as the
// adapter's failure message.
const INFORMATIONAL_STDERR_PATTERNS: readonly RegExp[] = [/^YOLO mode is enabled\b/i];

export function isInformationalStderrLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  return INFORMATIONAL_STDERR_PATTERNS.some((re) => re.test(trimmed));
}

export function firstSignificantStderrLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !isInformationalStderrLine(line)) ?? ""
  );
}
