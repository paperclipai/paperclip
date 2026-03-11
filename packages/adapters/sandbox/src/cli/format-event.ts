import { printClaudeStreamEvent } from "@paperclipai/adapter-claude-local/cli";
import { printCodexStreamEvent } from "@paperclipai/adapter-codex-local/cli";
import { printCursorStreamEvent } from "@paperclipai/adapter-cursor-local/cli";
import { printOpenCodeStreamEvent } from "@paperclipai/adapter-opencode-local/cli";
import { printPiStreamEvent } from "@paperclipai/adapter-pi-local/cli";
import { unwrapSandboxStdoutLine } from "../shared/protocol.js";

export function printSandboxStreamEvent(line: string, debug: boolean) {
  const wrapped = unwrapSandboxStdoutLine(line);
  if (!wrapped) {
    const trimmed = line.trim();
    if (trimmed) console.log(trimmed);
    return;
  }

  if (wrapped.agentType === "claude_local") return printClaudeStreamEvent(wrapped.line, debug);
  if (wrapped.agentType === "codex_local") return printCodexStreamEvent(wrapped.line, debug);
  if (wrapped.agentType === "cursor") return printCursorStreamEvent(wrapped.line, debug);
  if (wrapped.agentType === "opencode_local") return printOpenCodeStreamEvent(wrapped.line, debug);
  if (wrapped.agentType === "pi_local") return printPiStreamEvent(wrapped.line, debug);
  if (wrapped.line.trim()) console.log(wrapped.line);
}
