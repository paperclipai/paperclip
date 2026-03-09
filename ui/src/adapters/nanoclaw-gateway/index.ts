import type { UIAdapterModule } from "../types";
import { parseNanoClawGatewayStdoutLine } from "@paperclipai/adapter-nanoclaw-gateway/ui";
import { buildNanoClawGatewayConfig } from "@paperclipai/adapter-nanoclaw-gateway/ui";
import { NanoClawGatewayConfigFields } from "./config-fields";

export const nanoClawGatewayUIAdapter: UIAdapterModule = {
  type: "nanoclaw_gateway",
  label: "NanoClaw Gateway",
  parseStdoutLine: parseNanoClawGatewayStdoutLine,
  ConfigFields: NanoClawGatewayConfigFields,
  buildAdapterConfig: buildNanoClawGatewayConfig,
};
