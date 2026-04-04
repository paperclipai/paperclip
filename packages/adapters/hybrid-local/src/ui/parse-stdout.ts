import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";

/**
 * Parse stdout lines from both Claude CLI (JSON stream) and local
 * OpenAI-compatible endpoints (plain text prefixed with [hybrid]).
 *
 * Claude stream JSON lines are handled by the Claude parser.
 * Hybrid adapter log lines are passed through as system entries.
 */
export function parseHybridStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Hybrid adapter log lines
  if (trimmed.startsWith("[hybrid]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // Legacy prefix
  if (trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // Delegate to Claude stream JSON parser
  return parseClaudeStdoutLine(line, ts);
}
