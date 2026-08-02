import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildAgentskyCloudConfig,
  parseAgentskyCloudStdoutLine,
} from "@paperclipai/adapter-agentsky-cloud/ui";

export const agentskyCloudUIAdapter: UIAdapterModule = {
  type: "agentsky_cloud",
  label: "AgentSky",
  parseStdoutLine: parseAgentskyCloudStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildAgentskyCloudConfig,
};
