import type { UIAdapterModule } from "../types";
import {
  buildCopilotLocalConfig,
  parseCopilotStdoutLine,
} from "@paperclipai/adapter-copilot-local/ui";
import { CopilotLocalConfigFields } from "./config-fields";

export const copilotLocalUIAdapter: UIAdapterModule = {
  type: "copilot_local",
  label: "GitHub Copilot",
  parseStdoutLine: parseCopilotStdoutLine,
  ConfigFields: CopilotLocalConfigFields,
  buildAdapterConfig: buildCopilotLocalConfig,
};
