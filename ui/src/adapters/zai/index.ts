import type { UIAdapterModule } from "../types";
import { parseZaiStdoutLine } from "@paperclipai/adapter-zai/ui";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const zaiUIAdapter: UIAdapterModule = {
  type: "zai",
  label: "Z.AI (GLM)",
  parseStdoutLine: parseZaiStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
