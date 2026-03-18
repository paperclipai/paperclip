import type { TranscriptEntry } from "@paperclipai/adapter-utils";
import { stripAnsi } from "../server/parse.js";

/**
 * Kiro CLI outputs plain text in --no-interactive mode.
 * Each line is treated as stdout with ANSI codes stripped.
 */
export function parseKiroStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const clean = stripAnsi(line).trim();
  if (!clean) return [];
  return [{ kind: "stdout", ts, text: clean }];
}
