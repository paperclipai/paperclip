import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("assistant:")) {
    return [{ kind: "assistant", ts, text: trimmed.slice("assistant:".length).trim() }];
  }
  if (trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }
  return [{ kind: "stdout", ts, text: trimmed }];
}
