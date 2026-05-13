import type { UIAdapterModule } from "../types";
import { parseKilocodeGatewayStdoutLine } from "@paperclipai/adapter-kilocode-gateway/ui";
import { buildKilocodeGatewayConfig } from "@paperclipai/adapter-kilocode-gateway/ui";
import { KilocodeGatewayConfigFields } from "./config-fields";

export const kilocodeGatewayUIAdapter: UIAdapterModule = {
  type: "kilocode_gateway",
  label: "KiloCode Gateway",
  parseStdoutLine: parseKilocodeGatewayStdoutLine,
  ConfigFields: KilocodeGatewayConfigFields,
  buildAdapterConfig: buildKilocodeGatewayConfig,
};
