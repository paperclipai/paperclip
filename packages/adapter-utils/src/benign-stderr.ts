// ---------------------------------------------------------------------------
// Benign adapter stderr lines
//
// When a CLI agent exits non-zero without a structured error, adapters fall
// back to the first stderr line as the user-facing run error. That line is
// often a startup banner the adapter itself provoked (the approvals-bypass
// warning it enabled, or a "[paperclip] ..." diagnostic it injected), which
// then masks the real cause. Production spent weeks reporting "YOLO mode is
// enabled" as the failure of every Gemini run whose real error was a sandbox
// misconfiguration two lines lower.
//
// Keep this list conservative: a pattern listed here can hide a real error.
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /\[[0-9;]*m/g;

const BENIGN_STDERR_LINE_RES: readonly RegExp[] = [
  // Every adapter that runs unattended passes an approvals-bypass flag, so the
  // agent CLI always prints this. It is never the reason a run failed.
  /^YOLO mode is enabled\b/i,
  // Diagnostics the adapter itself wrote (ACP fallback notes, timeout notes,
  // sandbox suppression notes).
  /^\[paperclip\]/,
];

function normalizeStderrLine(line: string): string {
  return line.replace(ANSI_ESCAPE_RE, "").trim();
}

export function isBenignAdapterStderrLine(line: string): boolean {
  const normalized = normalizeStderrLine(line);
  if (!normalized) return true;
  return BENIGN_STDERR_LINE_RES.some((re) => re.test(normalized));
}

/**
 * The first stderr line that could plausibly explain a failure. Falls back to
 * the first non-empty line when every line is a benign banner, so a run whose
 * only output is a banner still reports something rather than nothing.
 */
export function firstMeaningfulStderrLine(text: string): string {
  const lines = text.split(/\r?\n/).map(normalizeStderrLine).filter(Boolean);
  return lines.find((line) => !isBenignAdapterStderrLine(line)) ?? lines[0] ?? "";
}
