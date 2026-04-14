import type { UIAdapterModule } from "../types";
import { parseAnvilStdoutLine, buildAnvilLocalConfig } from "@paperclipai/adapter-anvil-local/ui";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const anvilLocalUIAdapter: UIAdapterModule = {
  type: "anvil_local",
  label: "Anvil (local)",
  parseStdoutLine: parseAnvilStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildAnvilLocalConfig,
};
