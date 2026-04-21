import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseBastionclawStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
