import type { TranscriptEntry } from "../types";

export function parseQwenStdoutLine(line: string, ts: string): TranscriptEntry[] {
  // Simple passthrough for now - can be enhanced with Qwen-specific parsing later
  if (line.startsWith("[ollama]")) {
    const message = line.replace("[ollama]", "").trim();
    return [{ kind: "system" as const, ts, text: message }];
  }

  if (line.startsWith("ERROR") || line.startsWith("Error")) {
    return [{ kind: "stderr" as const, ts, text: line }];
  }

  return [{ kind: "stdout" as const, ts, text: line }];
}

export function buildQwenOllamaConfig(values: Record<string, any>): Record<string, unknown> {
  return {
    ollama_url: values.ollama_url || "http://localhost:11434",
    model: values.model || "qwen3.5",
  };
}
