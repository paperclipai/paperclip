import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { parseCursorStdoutLine } from "@paperclipai/adapter-cursor-local/ui";
import { parseOpenCodeStdoutLine } from "@paperclipai/adapter-opencode-local/ui";
import { parsePiStdoutLine } from "@paperclipai/adapter-pi-local/ui";
import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { fallbackStdoutEntry, unwrapSandboxStdoutLine } from "../shared/protocol.js";

export function parseSandboxStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const wrapped = unwrapSandboxStdoutLine(line);
  if (!wrapped) return fallbackStdoutEntry(line, ts);

  if (wrapped.agentType === "claude_local") return parseClaudeStdoutLine(wrapped.line, ts);
  if (wrapped.agentType === "codex_local") return parseCodexStdoutLine(wrapped.line, ts);
  if (wrapped.agentType === "cursor") return parseCursorStdoutLine(wrapped.line, ts);
  if (wrapped.agentType === "opencode_local") return parseOpenCodeStdoutLine(wrapped.line, ts);
  if (wrapped.agentType === "pi_local") return parsePiStdoutLine(wrapped.line, ts);
  return fallbackStdoutEntry(wrapped.line, ts);
}
