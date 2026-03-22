import type { StdoutLineParser, TranscriptEntry } from "@paperclipai/adapter-utils";
import { stripAnsi } from "../server/parse.js";

// Matches lines that look like error output.
const ERROR_LINE_RE = /^error[:\s]/i;

// Matches lines that look like tool invocations.
// e.g. "Running tool: bash", "Calling tool: read_file", "Tool call: ..."
const TOOL_CALL_LINE_RE = /^(?:running|calling|invoking|executing)\s+tool[:\s]|^tool[_\s-]?(?:call|use|start|invocation)[:\s]/i;

// Matches system/lifecycle lines.
// e.g. "Session: abc123", "Kiro init", "Agent started"
const SYSTEM_LINE_RE = /^(?:session[:\s]|kiro\s+init|agent\s+(?:started|finished|stopped)|credits:|time:)/i;

/**
 * Classify a cleaned (ANSI-stripped) Kiro stdout line into a transcript entry.
 * Kiro emits plain text rather than structured JSON, so classification is
 * heuristic — based on common line prefixes and keywords.
 */
function classifyLine(text: string, ts: string): TranscriptEntry {
  if (ERROR_LINE_RE.test(text)) {
    return { kind: "stderr", ts, text };
  }
  if (TOOL_CALL_LINE_RE.test(text)) {
    return { kind: "system", ts, text };
  }
  if (SYSTEM_LINE_RE.test(text)) {
    return { kind: "system", ts, text };
  }
  return { kind: "assistant", ts, text };
}

/**
 * Parse a stdout line into transcript entries.
 */
export const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
  if (!line || line.trim().length === 0) return [];

  // Strip ANSI escape codes before classifying
  const cleanedLine = stripAnsi(line).trim();
  if (!cleanedLine) return [];

  return [classifyLine(cleanedLine, ts)];
};
