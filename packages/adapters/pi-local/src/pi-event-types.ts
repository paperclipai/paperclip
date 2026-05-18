// Pi-coding-agent NDJSON event-type constants and a single-line filter for
// accumulated-state delta events. UI-safe: no Node-only or server-utils
// dependencies (only `JSON.parse`), so this module can be imported from
// browser builds (`src/ui/`) as well as server code (`src/server/`).
//
// The Pi event protocol is documented inline in `src/server/parse.ts`; keep
// this list as the single source of truth for which `message_update` event
// types carry accumulated partial state.

export const PI_DELTA = {
  thinking: "thinking_delta",
  text: "text_delta",
  toolcall: "toolcall_delta",
} as const;
export type PiDeltaEventType = (typeof PI_DELTA)[keyof typeof PI_DELTA];
export const PI_DELTA_EVENT_TYPES: readonly PiDeltaEventType[] = Object.values(PI_DELTA);
const DROPPABLE_DELTA_TYPES: ReadonlySet<string> = new Set(PI_DELTA_EVENT_TYPES);

/**
 * Returns true when `line` is an NDJSON `message_update` event whose
 * assistantMessageEvent.type is one of the accumulated-state delta types
 * (see PI_DELTA). Used by the pi-local adapter's bufferedOnLog filter to
 * keep these O(n²) lines out of the persisted run log.
 *
 * On any JSON.parse failure or shape mismatch, returns false (passthrough).
 */
export function isDroppableDeltaLine(line: string): boolean {
  // Cheap prefilter: avoid JSON.parse for lines that obviously don't match.
  if (!line.includes("_delta")) return false;
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event?.type !== "message_update") return false;
    const msg = event.assistantMessageEvent as Record<string, unknown> | undefined;
    const msgType = typeof msg?.type === "string" ? msg.type : "";
    return DROPPABLE_DELTA_TYPES.has(msgType);
  } catch {
    return false;
  }
}

// Per-line cap for `tool_execution_end.result` (bash/shell tool stdout+stderr
// captured by pi-coding-agent). Above the threshold we keep a head/tail slice
// with a `[paperclip] dropped N bytes …` marker — matches the stderr marker
// style in buffered-on-log.ts so the run log stays grep-friendly.
const TOOL_RESULT_HEAD_CHARS = 64 * 1024;
const TOOL_RESULT_TAIL_CHARS = 16 * 1024;
const TOOL_RESULT_PASSTHROUGH_THRESHOLD =
  TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS;

function truncateToolResultString(s: string): string {
  if (s.length <= TOOL_RESULT_PASSTHROUGH_THRESHOLD) return s;
  const head = s.slice(0, TOOL_RESULT_HEAD_CHARS);
  const tail = s.slice(s.length - TOOL_RESULT_TAIL_CHARS);
  const dropped = s.length - head.length - tail.length;
  return (
    head +
    `\n[paperclip] dropped ${dropped} bytes from tool result ` +
    `(kept ${TOOL_RESULT_HEAD_CHARS}B head + ${TOOL_RESULT_TAIL_CHARS}B tail)\n` +
    tail
  );
}

/**
 * Rewrites NDJSON event lines that carry bash/shell tool output:
 *   - `tool_execution_end` with a `result` string longer than the threshold
 *     is rewritten with the result truncated to head + marker + tail.
 *   - `turn_end` carrying a non-empty `toolResults` array has the array
 *     replaced with `[]` — the same payload is already in the preceding
 *     `tool_execution_end` line (parse.ts merges by toolCallId).
 *
 * All other events, lines that fail JSON.parse, and shape mismatches pass
 * through unchanged (mirrors `isDroppableDeltaLine`'s failure mode).
 *
 * Slicing is UTF-16 code-unit based — a multi-byte codepoint cut at the
 * boundary becomes a lone surrogate, which `JSON.stringify` then escapes
 * to `\uXXXX`. The output is always valid JSON.
 */
export function rewriteToolResultLine(line: string): string {
  // Cheap prefilter: avoid JSON.parse for the common delta-heavy stream.
  if (
    !line.includes('"tool_execution_end"') &&
    !line.includes('"turn_end"')
  ) {
    return line;
  }
  try {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event?.type === "tool_execution_end") {
      if (typeof event.result !== "string") return line;
      if (event.result.length <= TOOL_RESULT_PASSTHROUGH_THRESHOLD) return line;
      event.result = truncateToolResultString(event.result);
      return JSON.stringify(event);
    }
    if (event?.type === "turn_end") {
      const trs = event.toolResults;
      if (!Array.isArray(trs) || trs.length === 0) return line;
      event.toolResults = [];
      return JSON.stringify(event);
    }
    return line;
  } catch {
    return line;
  }
}
