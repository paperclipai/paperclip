import type { UIAdapterModule } from "../types";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";
import { parseHttpStdoutLine } from "../http/parse-stdout";

export const agentZeroBridgeUIAdapter: UIAdapterModule = {
  type: "agent_zero_bridge",
  label: "Agent Zero Bridge",
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
