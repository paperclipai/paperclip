import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseBlockRunStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();

  // Parse blockrun metadata lines
  if (trimmed.startsWith("[blockrun]")) {
    // Check if this is the agent output boundary
    if (trimmed.includes("--- agent output ---") || trimmed.includes("--- end output ---")) {
      return [{ kind: "system", ts, text: trimmed }];
    }

    // Cost/model info lines
    if (trimmed.includes("model=") || trimmed.includes("cost=$") || trimmed.includes("payment required")) {
      return [{ kind: "system", ts, text: trimmed }];
    }

    return [{ kind: "stdout", ts, text: trimmed }];
  }

  // Regular content — likely agent response text
  return [{ kind: "assistant", ts, text: line }];
}
