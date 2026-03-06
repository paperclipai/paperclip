import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseCopilotStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  if (
    trimmed.startsWith("─") || trimmed.startsWith("╭") ||
    trimmed.startsWith("╰") || trimmed.startsWith("│") ||
    /^GitHub Copilot\s/i.test(trimmed) || /^I'm powered by AI/i.test(trimmed)
  ) return [];
  return [{ kind: "assistant", ts, text: trimmed }];
}
