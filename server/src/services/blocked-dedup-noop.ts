function readSignalText(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const BLOCKED_DEDUP_SIGNAL_RE = /\b(?:recognized|recognised)\s+blocked-?dedup\b/i;
const ALREADY_BLOCKED_SIGNAL_RE = /\balready blocked\b/i;
const NOTHING_NEW_SIGNAL_RE = /\bnothing new since\b/i;
const NO_CHURN_SIGNAL_RE =
  /\b(?:no comment,\s*status change,\s*or reopen|do not re-comment|don't re-comment|do nothing that churns|no status change|no reopen)\b/i;
const EXIT_CLEANLY_SIGNAL_RE = /\b(?:exit(?:ing)? cleanly|quiet no-?op|no-?op)\b/i;
const LEAVE_BLOCKED_SIGNAL_RE = /\b(?:leave|leaving)\s+(?:the issue\s+)?blocked\b/i;

export function isBlockedDedupNoOpText(value: unknown) {
  const text = readSignalText(value);
  if (!text) return false;

  const blockedSignal =
    BLOCKED_DEDUP_SIGNAL_RE.test(text) ||
    (ALREADY_BLOCKED_SIGNAL_RE.test(text) && NOTHING_NEW_SIGNAL_RE.test(text));
  if (!blockedSignal) return false;

  return NO_CHURN_SIGNAL_RE.test(text) ||
    EXIT_CLEANLY_SIGNAL_RE.test(text) ||
    LEAVE_BLOCKED_SIGNAL_RE.test(text);
}

export function hasBlockedDedupNoOpSignal(values: Iterable<unknown>) {
  for (const value of values) {
    if (isBlockedDedupNoOpText(value)) return true;
  }
  return false;
}

export function isBlockedDedupNoOpResult(
  resultJson: Record<string, unknown> | null | undefined,
) {
  if (!resultJson) return false;
  return hasBlockedDedupNoOpSignal([
    resultJson.summary,
    resultJson.result,
    resultJson.message,
  ]);
}
