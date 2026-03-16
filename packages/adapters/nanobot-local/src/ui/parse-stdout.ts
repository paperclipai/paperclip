import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseNanobotLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // System lines from the adapter itself
  if (trimmed.startsWith("[nanobot-local]")) {
    const text = trimmed.replace(/^\[nanobot-local\]\s*/, "");

    // Error lines
    if (text.startsWith("HTTP ") || text.startsWith("error:") || text.startsWith("request timed out")) {
      return [{ kind: "stderr", ts, text }];
    }

    return [{ kind: "system", ts, text }];
  }

  // Everything else is the agent's response text
  return [{ kind: "assistant", ts, text: trimmed }];
}
