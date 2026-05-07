import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseDeepseekStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[deepseek]")) {
    return [{ kind: "system", ts, text: trimmed.replace(/^\[deepseek\]\s*/, "") }];
  }
  return [{ kind: "assistant", ts, text: line }];
}
