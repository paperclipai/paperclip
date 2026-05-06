import type { TranscriptEntry } from "../types";

const ASSISTANT_PREFIX = "[ollama_local:assistant] ";
const TOOL_PREFIX = "[ollama_local:tool] ";
const SKILLS_PREFIX = "[ollama_local:skills] ";
const SYSTEM_PREFIX = "[ollama_local] ";

export function parseOllamaLocalStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (line.startsWith(ASSISTANT_PREFIX)) {
    return [{ kind: "assistant", ts, text: line.slice(ASSISTANT_PREFIX.length) }];
  }
  if (line.startsWith(TOOL_PREFIX) || line.startsWith(SKILLS_PREFIX) || line.startsWith(SYSTEM_PREFIX)) {
    const prefixes = [TOOL_PREFIX, SKILLS_PREFIX, SYSTEM_PREFIX];
    const prefix = prefixes.find((value) => line.startsWith(value)) || "";
    return [{ kind: "system", ts, text: line.slice(prefix.length) }];
  }
  return [{ kind: "stdout", ts, text: line }];
}
