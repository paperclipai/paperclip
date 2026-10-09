import type { RunSessionOutcome } from "./run-state.js";

const MAX_RUN_ERROR_MESSAGE_LINES = 16;
const MAX_RUN_ERROR_MESSAGE_CHARS = 1024;

/**
 * Where a resolved run error message came from.
 *
 * Callers that *decide* something from the message (retry classification, stop
 * reason inference) must only trust `recorded` and `adapter`: those are
 * structured, adapter-owned text. A `stderr_excerpt` message is triage display
 * only — it is arbitrary process output and can contain any substring those
 * classifiers look for.
 */
export type RunErrorMessageSource =
  | "recorded"
  | "adapter"
  | "stderr_excerpt"
  | "label";

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

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
  if (tail.length <= MAX_RUN_ERROR_MESSAGE_CHARS) return tail;
  // Never start the tail inside a surrogate pair. Cutting a fixed number of
  // UTF-16 units off the end of an astral character leaves a lone low
  // surrogate, which renders as a replacement character everywhere `error` is
  // shown; dropping it costs one unit of an already truncated excerpt.
  const start = tail.length - MAX_RUN_ERROR_MESSAGE_CHARS;
  return tail.slice(isLowSurrogate(tail.charCodeAt(start)) ? start + 1 : start);
}

/**
 * Resolve the `error` column for a heartbeat run that reached a final outcome.
 *
 * An adapter that exits non-zero without a structured error used to persist
 * only the generic outcome label, which makes an infrastructure outage look
 * the same as an agent bug on the run row. The captured stderr excerpt already
 * holds the cause, so its tail becomes the message when the adapter gave none.
 *
 * The returned `source` says whether the message is adapter-owned text or a
 * stderr tail, so a caller can show the tail without feeding it to a
 * text-matching classifier. The caller redacts the returned message.
 * `message: null` means the run has no error.
 */
export function resolveRunErrorMessage(input: {
  outcome: RunSessionOutcome;
  adapterErrorMessage: string | null | undefined;
  recordedError: string | null | undefined;
  stderrExcerpt: string | null | undefined;
}): { message: string | null; source: RunErrorMessageSource | null } {
  if (input.outcome === "succeeded") return { message: null, source: null };

  // The cancelled path keeps the already recorded error ahead of everything
  // else, as it did before this fallback existed.
  if (input.outcome === "cancelled" && input.recordedError != null) {
    return { message: input.recordedError, source: "recorded" };
  }

  if (input.adapterErrorMessage != null) {
    return { message: input.adapterErrorMessage, source: "adapter" };
  }

  const stderrTail = extractStderrExcerptTail(input.stderrExcerpt);
  if (stderrTail !== null) {
    return { message: stderrTail, source: "stderr_excerpt" };
  }

  return {
    message:
      input.outcome === "cancelled"
        ? "Cancelled"
        : input.outcome === "timed_out"
          ? "Timed out"
          : "Adapter failed",
    source: "label",
  };
}
