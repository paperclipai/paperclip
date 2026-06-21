import type { UIAdapterModule } from "../types";
import {
  buildOllamaLocalConfig,
  parseOllamaStdoutLine,
} from "@paperclipai/adapter-ollama-local/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const ollamaLocalUIAdapter: UIAdapterModule = {
  type: "ollama_local",
  label: "Ollama (local)",
  parseStdoutLine: parseOllamaStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildOllamaLocalConfig,
};
