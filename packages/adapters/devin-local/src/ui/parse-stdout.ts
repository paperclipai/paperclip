import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseDevinLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }
  return [{ kind: "assistant", ts, text: line }];
}
