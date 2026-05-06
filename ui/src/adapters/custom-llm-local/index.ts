import type { UIAdapterModule } from "../types";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";
import { parseHttpStdoutLine } from "../http/parse-stdout";

export const customLlmLocalUIAdapter: UIAdapterModule = {
  type: "custom_llm_local",
  label: "Custom LLM (Local)",
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
