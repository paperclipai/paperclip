import type { UIAdapterModule } from "../types";
import { parseOllamaStdoutLine } from "./parse-stdout";
import { OllamaLocalConfigFields } from "./config-fields";
import { buildOllamaLocalConfig } from "./build-config";

export const ollamaLocalUIAdapter: UIAdapterModule = {
  type: "ollama_local",
  label: "Ollama (local)",
  parseStdoutLine: parseOllamaStdoutLine,
  ConfigFields: OllamaLocalConfigFields,
  buildAdapterConfig: buildOllamaLocalConfig,
};
