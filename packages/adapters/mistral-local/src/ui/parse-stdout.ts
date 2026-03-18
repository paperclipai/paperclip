import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseMistralStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "assistant", ts, text: line }];
}
