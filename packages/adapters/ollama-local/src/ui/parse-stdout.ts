import type { StdoutLineParser, TranscriptEntry } from "@paperclipai/adapter-utils";

/**
 * UI transcript parser for ollama_local runs.
 *
 * The adapter emits raw assistant tokens via onLog("stdout", piece) and
 * adapter-status notes via onLog("stderr", "[paperclip] …"). There is no
 * structured JSONL event stream (unlike claude-local/gemini-local), so the
 * parser treats each line as either:
 *   - a paperclip system/stderr note ("[paperclip] …" prefix)
 *   - an assistant text chunk
 */
export const parseStdoutLine: StdoutLineParser = (line: string, ts: string): TranscriptEntry[] => {
  if (!line) return [];
  const trimmed = line.replace(/\r?\n$/, "");
  if (trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }
  return [{ kind: "assistant", ts, text: trimmed, delta: true }];
};

export default parseStdoutLine;
