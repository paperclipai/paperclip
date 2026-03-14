import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b\[[\?]?\d*[a-zA-Z]/g;

/**
 * Kiro CLI outputs plain text in --no-interactive mode.
 * Each line is treated as stdout with ANSI codes stripped.
 */
export function parseKiroStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const clean = line.replace(ANSI_RE, "").trim();
  if (!clean) return [];
  return [{ kind: "stdout", ts, text: clean }];
}
