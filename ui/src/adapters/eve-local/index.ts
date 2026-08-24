import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import { buildEveLocalConfig, parseEveStdoutLine } from "@paperclipai/adapter-eve/ui";

export const eveLocalUIAdapter: UIAdapterModule = {
  type: "eve_local",
  label: "Eve",
  parseStdoutLine: parseEveStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildEveLocalConfig,
};
