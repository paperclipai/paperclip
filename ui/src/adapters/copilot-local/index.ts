import type { UIAdapterModule } from "../types";
import { parseCopilotStdoutLine } from "@paperclipai/adapter-copilot-local/ui";
import { CopilotLocalConfigFields } from "./config-fields";
import { buildCopilotLocalConfig } from "@paperclipai/adapter-copilot-local/ui";

export const copilotLocalUIAdapter: UIAdapterModule = {
  type: "copilot_local",
  label: "Copilot (local)",
  parseStdoutLine: parseCopilotStdoutLine,
  ConfigFields: CopilotLocalConfigFields,
  buildAdapterConfig: buildCopilotLocalConfig,
};
