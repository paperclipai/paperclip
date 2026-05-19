import type { TranscriptEntry } from "../types";

export function parseAtomicAgentHttpStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
