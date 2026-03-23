import type { UIAdapterModule } from "../types";
import { parseCopilotStdoutLine } from "@paperclipai/adapter-copilot-cli/ui";
import { CopilotCliConfigFields } from "./config-fields";
import { buildCopilotCliConfig } from "@paperclipai/adapter-copilot-cli/ui";

export const copilotCliUIAdapter: UIAdapterModule = {
  type: "copilot_cli",
  label: "GitHub Copilot CLI",
  parseStdoutLine: parseCopilotStdoutLine,
  ConfigFields: CopilotCliConfigFields,
  buildAdapterConfig: buildCopilotCliConfig,
};
