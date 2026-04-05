import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export function parseDashScopeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  // Default stdout line parser for DashScope
  // Simply returns the line as stdout
  return [{ type: "stdout", ts, text: line }];
}
