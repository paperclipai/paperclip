import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import { buildEveGatewayConfig, parseEveStdoutLine } from "@paperclipai/adapter-eve/ui";

export const eveGatewayUIAdapter: UIAdapterModule = {
  type: "eve_gateway",
  label: "Eve Gateway",
  parseStdoutLine: parseEveStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildEveGatewayConfig,
};
