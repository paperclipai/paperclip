import type { UIAdapterModule } from "../types";
import { parseQwenStdoutLine, buildQwenOllamaConfig } from "./parse-stdout";
import { QwenOllamaConfigFields } from "./config-fields";

// Re-export for convenience
export { parseQwenStdoutLine, buildQwenOllamaConfig };

export const qwenOllamaUIAdapter: UIAdapterModule = {
  type: "qwen_ollama_local",
  label: "Qwen via Ollama (Local)",
  parseStdoutLine: parseQwenStdoutLine,
  ConfigFields: QwenOllamaConfigFields,
  buildAdapterConfig: buildQwenOllamaConfig,
};
