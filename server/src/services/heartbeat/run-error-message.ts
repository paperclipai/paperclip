import type { RunSessionOutcome } from "./run-state.js";

const MAX_RUN_ERROR_MESSAGE_LINES = 16;
const MAX_RUN_ERROR_MESSAGE_CHARS = 1024;

/**
 * Derive a bounded tail of an already-captured stderr excerpt.
 *
 * The excerpt on the run row is redacted and byte-capped when it is captured,
 * so this only has to bound its own output: the last few lines, plus a hard
 * character cap for a single very long line. Empty, whitespace-only, and
 * non-string input return `null` so a caller can fall through to its label.
 */
export function extractStderrExcerptTail(
  excerpt: string | null | undefined,
): string | null {
  if (typeof excerpt !== "string") return null;
  const trimmed = excerpt.trim();
  if (!trimmed) return null;
  const tail = trimmed
    .split("\n")
    .slice(-MAX_RUN_ERROR_MESSAGE_LINES)
    .join("\n");
  return tail.length > MAX_RUN_ERROR_MESSAGE_CHARS
    ? tail.slice(-MAX_RUN_ERROR_MESSAGE_CHARS)
    : tail;
}

/**
 * Resolve the `error` column for a heartbeat run that reached a final outcome.
 *
 * An adapter that exits non-zero without a structured error used to persist
 * only the generic outcome label, which makes an infrastructure outage look
 * the same as an agent bug on the run row. The captured stderr excerpt already
 * holds the cause, so its tail becomes the message when the adapter gave none.
 *
 * The caller redacts the returned message. `null` means the run has no error.
 */
export function resolveRunErrorMessage(input: {
  outcome: RunSessionOutcome;
  adapterErrorMessage: string | null | undefined;
  recordedError: string | null | undefined;
  stderrExcerpt: string | null | undefined;
}): string | null {
  if (input.outcome === "succeeded") return null;

  const stderrTail = extractStderrExcerptTail(input.stderrExcerpt);

  if (input.outcome === "cancelled") {
    return (
      input.recordedError ??
      input.adapterErrorMessage ??
      stderrTail ??
      "Cancelled"
    );
  }

  return (
    input.adapterErrorMessage ??
    stderrTail ??
    (input.outcome === "timed_out" ? "Timed out" : "Adapter failed")
  );
}
