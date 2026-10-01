import type { TranscriptEntry } from "../types";

export function parseHttpStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
