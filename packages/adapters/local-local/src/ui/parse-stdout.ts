import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";

/**
 * Parse stdout lines from both Claude CLI (JSON stream) and LM Studio
 * (plain text prefixed with [paperclip]).
 *
 * Claude stream JSON lines are handled by the Claude parser.
 * LM Studio log lines are passed through as stdout entries.
 */
export function parseLocalLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // LM Studio log lines from our adapter
  if (trimmed.startsWith("[paperclip] LM Studio:")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // Paperclip fallback notice
  if (trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // Try parsing as Claude stream JSON
  return parseClaudeStdoutLine(line, ts);
}
