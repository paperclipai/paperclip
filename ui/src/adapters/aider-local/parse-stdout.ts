import type { TranscriptEntry } from "../types";

/**
 * Aider produces human-readable text rather than streaming JSON, so the v1
 * UI parser is a pass-through. The transcript view uses generic stdout/stderr
 * styling, with the raw lines preserved for fidelity.
 */
export function parseAiderStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
