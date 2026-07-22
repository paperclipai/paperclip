import type { TranscriptEntry } from "../types";

export function parseProcessStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
