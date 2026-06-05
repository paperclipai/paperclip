import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const OLLAMA_LOG_PREFIX = "[ollama-local]";

/**
 * ollama_local emits human-readable log lines via ctx.onLog, not structured
 * JSONL. We pass stdout/stderr through as-is so the UI shows them verbatim.
 */
export function parseOllamaLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (!line.length) return [];
  if (line.startsWith(OLLAMA_LOG_PREFIX)) {
    return [{ kind: "system", ts, text: line }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
