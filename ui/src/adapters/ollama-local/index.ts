import type { UIAdapterModule } from "../types";
import { parseOllamaStdoutLine } from "@paperclipai/adapter-ollama-local/ui";
import { buildOllamaLocalConfig } from "@paperclipai/adapter-ollama-local/ui";
import { OllamaLocalConfigFields } from "./config-fields";

export const ollamaLocalUIAdapter: UIAdapterModule = {
  type: "ollama_local",
  label: "Ollama (local)",
  parseStdoutLine: parseOllamaStdoutLine,
  ConfigFields: OllamaLocalConfigFields,
  buildAdapterConfig: buildOllamaLocalConfig,
};
