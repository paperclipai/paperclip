import type { RunSessionOutcome } from "./run-state.js";

const MAX_RUN_ERROR_MESSAGE_LINES = 16;
const MAX_RUN_ERROR_MESSAGE_CHARS = 1024;

export type RunErrorMessageSource =
  | "recorded"
  | "adapter"
  | "stderr_excerpt"
  | "label";

function isLowSurrogate(code: number) {
  return code >= 0xdc00 && code <= 0xdfff;
}

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
  const start = tail.length - MAX_RUN_ERROR_MESSAGE_CHARS;
  return tail.slice(isLowSurrogate(tail.charCodeAt(start)) ? start + 1 : start);
}

export function resolveRunErrorMessage(input: {
  outcome: RunSessionOutcome;
  adapterErrorMessage: string | null | undefined;
  recordedError: string | null | undefined;
  stderrExcerpt: string | null | undefined;
}): { message: string | null; source: RunErrorMessageSource | null } {
  if (input.outcome === "succeeded") return { message: null, source: null };

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
