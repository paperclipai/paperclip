/**
 * Wrapper around the external hermes-paperclip-adapter stdout parser.
 *
 * The external adapter creates `tool_call` entries with `input` as an object
 * (e.g. `{ command: "..." }`, `{ path: "..." }`). When these objects reach
 * the UI, some rendering paths coerce them via default toString() which
 * produces "[object Object]" instead of readable text.
 *
 * This wrapper post-processes every entry, stringifying any non-string `input`
 * fields to JSON so the UI always receives plain text.
 */
import type { TranscriptEntry } from "../types";
import { parseHermesStdoutLine as rawParse } from "hermes-paperclip-adapter/ui";

function stringifyInput(entry: TranscriptEntry): TranscriptEntry {
  if (entry.kind === "tool_call" && typeof entry.input !== "string") {
    try {
      return {
        ...entry,
        input: JSON.stringify(entry.input, null, 2),
      };
    } catch {
      return {
        ...entry,
        input: String(entry.input),
      };
    }
  }
  return entry;
}

export function parseHermesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const entries = rawParse(line, ts);
  return entries.map(stringifyInput);
}
