import type { UIAdapterModule } from "../types";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";
import { parseOllamaLocalStdoutLine } from "./parse-stdout";

export const ollamaLocalUIAdapter: UIAdapterModule = {
  type: "ollama_local",
  label: "Ollama (Local)",
  parseStdoutLine: parseOllamaLocalStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
