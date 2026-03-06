import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseOpenClawStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
