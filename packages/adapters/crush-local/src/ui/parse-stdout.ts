import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseCrushStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line.trim()) return [];
  return [{ kind: "stdout", ts, text: line }];
}
