import type { UIAdapterModule } from "../types";
import { parseOpenClawGatewayStdoutLine } from "@odysseus/adapter-openclaw-gateway/ui";
import { buildOpenClawGatewayConfig } from "@odysseus/adapter-openclaw-gateway/ui";
import { OpenClawGatewayConfigFields } from "./config-fields";

export const openClawGatewayUIAdapter: UIAdapterModule = {
  type: "openclaw_gateway",
  label: "OpenClaw Gateway",
  parseStdoutLine: parseOpenClawGatewayStdoutLine,
  ConfigFields: OpenClawGatewayConfigFields,
  buildAdapterConfig: buildOpenClawGatewayConfig,
};
