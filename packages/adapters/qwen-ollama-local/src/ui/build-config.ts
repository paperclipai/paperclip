import type { CreateConfigValues } from "@paperclipai/adapter-utils";

export function buildQwenOllamaConfig(values: CreateConfigValues): Record<string, unknown> {
  return {
    ollama_url: (values as any).ollama_url || "http://localhost:11434",
    model: (values as any).model || "qwen3.5",
  };
}
