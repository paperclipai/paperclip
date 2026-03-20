import pc from "picocolors";

/**
 * Format a transcript event for terminal output.
 */
export function formatStdoutEvent(line: string, debug: boolean): void {
  if (!line || line.trim().length === 0) return;

  // Basic formatting for Kiro output
  // Could be enhanced to parse structured output if needed
  if (debug) {
    console.error(pc.gray(`[DEBUG] ${line}`));
  } else {
    console.log(line);
  }
}
