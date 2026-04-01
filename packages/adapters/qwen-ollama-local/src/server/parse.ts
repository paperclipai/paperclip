/**
 * Parse Qwen output for structured data extraction
 * Qwen returns plain text, so we look for common patterns
 */
export function parseQwenOutput(output: string): Record<string, unknown> {
  const lines = output.split("\n").filter((line) => line.trim());

  return {
    lineCount: lines.length,
    firstLine: lines[0] || null,
    textLength: output.length,
  };
}

/**
 * Convert a single stdout line into transcript entries
 * Used by the UI to display real-time output
 */
export function parseStdoutLine(
  line: string,
  timestamp: string
): Array<{
  type: string;
  ts: string;
  text?: string;
  error?: boolean;
}> {
  if (line.startsWith("[ollama]")) {
    const message = line.replace("[ollama]", "").trim();
    return [{ type: "system", ts: timestamp, text: message }];
  }

  if (line.startsWith("ERROR") || line.startsWith("Error")) {
    return [{ type: "error", ts: timestamp, text: line, error: true }];
  }

  return [{ type: "text", ts: timestamp, text: line }];
}
