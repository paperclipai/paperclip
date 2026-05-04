import type { UIAdapterModule } from "../types";
import { parseStdoutLine } from "@paperclipai/adapter-openrouter-local/ui-parser";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const openrouterLocalUIAdapter: UIAdapterModule = {
  type: "openrouter_local",
  label: "OpenRouter (local)",
  parseStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
