import type { TranscriptEntry } from "../types";

export function parseAgentBridgeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
