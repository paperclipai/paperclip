import type { TranscriptEntry } from "../types";

export function parsePollStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
