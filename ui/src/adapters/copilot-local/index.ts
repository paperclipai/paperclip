import type { UIAdapterModule } from "../types";
import { buildCopilotLocalConfig } from "./build-config";
import { createCopilotStdoutParser, parseCopilotStdoutLine } from "./parse-stdout";
import { CopilotLocalConfigFields } from "./config-fields";

export const copilotLocalUIAdapter: UIAdapterModule = {
  type: "copilot_local",
  label: "GitHub Copilot CLI (local)",
  parseStdoutLine: parseCopilotStdoutLine,
  createStdoutParser: createCopilotStdoutParser,
  ConfigFields: CopilotLocalConfigFields,
  buildAdapterConfig: buildCopilotLocalConfig,
};
