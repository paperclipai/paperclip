import type { UIAdapterModule } from "../types";
import { parseHermesGatewayStdoutLine } from "@paperclipai/adapter-hermes-gateway/ui";
import { buildHermesGatewayConfig } from "@paperclipai/adapter-hermes-gateway/ui";
import { HermesGatewayConfigFields } from "./config-fields";

export const hermesGatewayUIAdapter: UIAdapterModule = {
  type: "hermes_gateway",
  label: "Hermes Gateway",
  parseStdoutLine: parseHermesGatewayStdoutLine,
  ConfigFields: HermesGatewayConfigFields,
  buildAdapterConfig: buildHermesGatewayConfig,
};
