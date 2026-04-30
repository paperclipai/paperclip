import pc from "picocolors";
import type { CLIAdapterModule } from "@paperclipai/adapter-utils";

/**
 * ollama_local streams raw token text to stdout (no JSONL framing). The CLI
 * simply passes it through so `paperclipai tail` shows the assistant output
 * as it arrives. Structured events are limited to stderr "[paperclip]" lines
 * emitted by server/execute.ts.
 */
export function formatStdoutEvent(line: string, debug: boolean): void {
  if (!line) return;
  if (debug) {
    process.stdout.write(`${pc.dim("[ollama]")} ${line}\n`);
    return;
  }
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

export const cliAdapter: CLIAdapterModule = {
  type: "ollama_local",
  formatStdoutEvent,
};
