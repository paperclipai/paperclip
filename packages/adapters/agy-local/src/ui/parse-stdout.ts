import type { TranscriptEntry } from "@paperclipai/adapter-utils";

// agy --print writes plain text to stdout (no structured JSON stream),
// so each line is surfaced as-is — same convention as the generic
// process adapter's parser.
export function parseAgyStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
