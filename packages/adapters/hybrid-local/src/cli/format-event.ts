import pc from "picocolors";
import { printClaudeStreamEvent } from "@paperclipai/adapter-claude-local/cli";

export function printHybridStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  // Hybrid adapter log lines (fallback notices, local model logs)
  if (line.startsWith("[hybrid]")) {
    console.log(pc.yellow(line));
    return;
  }

  // Legacy prefix
  if (line.startsWith("[paperclip]")) {
    console.log(pc.yellow(line));
    return;
  }

  // Delegate to Claude stream formatter (handles JSON stream events)
  printClaudeStreamEvent(raw, debug);
}
