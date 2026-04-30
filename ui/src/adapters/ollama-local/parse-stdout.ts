import type { TranscriptEntry } from "../types";

/**
 * Ollama_local writes the model's reply directly to stdout once per run.
 * No streaming, no special framing — just plain text. Pass it through.
 */
export function parseOllamaStdoutLine(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
