import type { StdoutLineParser } from "@paperclipai/adapter-utils";

/**
 * Parse a stdout line into transcript entries.
 */
export const parseStdoutLine: StdoutLineParser = (line: string, ts: string) => {
  if (!line || line.trim().length === 0) return [];

  // Return assistant output
  return [{ kind: "assistant", ts, text: line }];
};
