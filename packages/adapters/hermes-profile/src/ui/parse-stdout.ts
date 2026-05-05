import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseHermesProfileStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (line.startsWith("session_id:")) return [];
  return [{ kind: "stdout", ts, text: line }];
}
