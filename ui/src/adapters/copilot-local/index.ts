import type { UIAdapterModule } from "../types";
import {
  buildCopilotLocalConfig,
  createCopilotStdoutParser,
  parseCopilotStdoutLine,
} from "@paperclipai/adapter-copilot-local/ui";
import { CopilotLocalConfigFields } from "./config-fields";

export const copilotLocalUIAdapter: UIAdapterModule = {
  type: "copilot_local",
  label: "GitHub Copilot CLI (local)",
  parseStdoutLine: parseCopilotStdoutLine,
  createStdoutParser: createCopilotStdoutParser,
  ConfigFields: CopilotLocalConfigFields,
  buildAdapterConfig: buildCopilotLocalConfig,
};
