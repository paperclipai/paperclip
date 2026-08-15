import type { TranscriptEntry } from "../types";

export function parseDeflectorStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
