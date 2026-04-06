import type { UIAdapterModule } from "../types";
import { parseHermesStdoutLine } from "hermes-paperclip-adapter/ui";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: (values) => {
    const config = buildSchemaAdapterConfig(values);
    if (config.command) {
      config.hermesCommand = config.command;
    }
    return config;
  },
};
