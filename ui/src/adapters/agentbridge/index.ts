import type { UIAdapterModule } from "../types";
import { parseAgentBridgeStdoutLine } from "./parse-stdout";
import { AgentBridgeConfigFields } from "./config-fields";
import { buildAgentBridgeConfig } from "./build-config";

export const agentbridgeUIAdapter: UIAdapterModule = {
  type: "agentbridge",
  label: "AgentBridge",
  parseStdoutLine: parseAgentBridgeStdoutLine,
  ConfigFields: AgentBridgeConfigFields,
  buildAdapterConfig: buildAgentBridgeConfig,
};
