import type { UIAdapterModule } from "../types";
import { parseCopilotStdoutLine, buildCopilotLocalConfig } from "@paperclipai/adapter-copilot-local/ui";
import { CopilotLocalConfigFields } from "./config-fields";

export const copilotLocalUIAdapter: UIAdapterModule = {
  type: "copilot_local",
  label: "GitHub Copilot (local)",
  parseStdoutLine: parseCopilotStdoutLine,
  ConfigFields: CopilotLocalConfigFields,
  buildAdapterConfig: buildCopilotLocalConfig,
};
