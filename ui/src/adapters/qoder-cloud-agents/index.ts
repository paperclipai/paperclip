import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildQoderCloudAgentsConfig,
  parseQoderCloudAgentsStdoutLine,
} from "@paperclipai/adapter-qoder-cloud-agents/ui";

export const qoderCloudAgentsUIAdapter: UIAdapterModule = {
  type: "qoder_cloud_agents",
  label: "Qoder Cloud Agents",
  parseStdoutLine: parseQoderCloudAgentsStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildQoderCloudAgentsConfig,
};
