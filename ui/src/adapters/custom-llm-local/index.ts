import type { UIAdapterModule } from "../types";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const customLlmLocalUIAdapter: UIAdapterModule = {
  type: "custom_llm_local",
  label: "Custom LLM (Local)",
  parseStdoutLine: () => [],
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
