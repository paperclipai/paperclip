import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const text = line.trim();
  return text ? [{ kind: "assistant", ts, text }] : [];
}
