import type { UIAdapterModule } from "../types";
import { parseCopilotStdoutLine, buildCopilotLocalConfig } from "@paperclipai/adapter-copilot-local/ui";
import { CursorLocalConfigFields as CopilotLocalConfigFields } from "./config-fields";

export const copilotLocalUIAdapter: UIAdapterModule = {
  type: "copilot_local",
  label: "GitHub Copilot CLI (local)",
  parseStdoutLine: parseCopilotStdoutLine,
  ConfigFields: CopilotLocalConfigFields,
  buildAdapterConfig: buildCopilotLocalConfig,
};
