import pc from "picocolors";
import { printClaudeStreamEvent } from "@paperclipai/adapter-claude-local/cli";

export function printLocalLocalStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  // LM Studio log lines from our adapter
  if (line.startsWith("[paperclip] LM Studio:")) {
    console.log(pc.cyan(line));
    return;
  }

  // Paperclip fallback / routing notices
  if (line.startsWith("[paperclip]")) {
    console.log(pc.yellow(line));
    return;
  }

  // Delegate to Claude stream formatter (handles JSON stream events)
  printClaudeStreamEvent(raw, debug);
}
