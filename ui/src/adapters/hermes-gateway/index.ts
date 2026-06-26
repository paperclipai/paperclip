import type { UIAdapterModule } from "../types";
import { parseStdoutLine as parseHermesGatewayStdoutLine } from "@paperclipai/adapter-hermes-gateway/ui";
import { SchemaConfigFields, buildSchemaAdapterConfig } from "../schema-config-fields";

export const hermesGatewayUIAdapter: UIAdapterModule = {
  type: "hermes_gateway",
  label: "Hermes Gateway",
  parseStdoutLine: parseHermesGatewayStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildSchemaAdapterConfig,
};
