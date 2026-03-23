import pc from "picocolors";
import { stripAnsi } from "../server/parse.js";

// Keep in sync with parse-stdout.ts classifiers.
const ERROR_LINE_RE = /^error[:\s]/i;
const TOOL_CALL_LINE_RE = /^(?:running|calling|invoking|executing)\s+tool[:\s]|^tool[_\s-]?(?:call|use|start|invocation)[:\s]/i;
const SYSTEM_LINE_RE = /^(?:session[:\s]|kiro\s+init|agent\s+(?:started|finished|stopped)|credits:|time:)/i;

/**
 * Format a Kiro stdout line for terminal output with colored formatting.
 * Matches the style of cursor-local and gemini-local adapters.
 */
export function formatStdoutEvent(line: string, debug: boolean): void {
  const cleaned = stripAnsi(line).trim();
  if (!cleaned) return;

  if (debug) {
    console.error(pc.gray(`[DEBUG] ${cleaned}`));
    return;
  }

  if (ERROR_LINE_RE.test(cleaned)) {
    console.log(pc.red(cleaned));
    return;
  }

  if (TOOL_CALL_LINE_RE.test(cleaned)) {
    console.log(pc.yellow(cleaned));
    return;
  }

  if (SYSTEM_LINE_RE.test(cleaned)) {
    console.log(pc.blue(cleaned));
    return;
  }

  console.log(pc.green(cleaned));
}
