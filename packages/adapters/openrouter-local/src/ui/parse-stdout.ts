import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const TOOL_LOG_RE = /^\[tool:([^\]]+)\] (.*)$/s;

export function parseOpenRouterStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  const toolMatch = trimmed.match(TOOL_LOG_RE);
  if (toolMatch) {
    const toolName = toolMatch[1];
    const rest = toolMatch[2];
    let input: unknown = rest;
    try { input = JSON.parse(rest); } catch { /* keep as string */ }
    return [{ kind: "tool_call", ts, name: toolName, input }];
  }

  return [{ kind: "assistant", ts, text: trimmed }];
}
