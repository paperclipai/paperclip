import type { UIAdapterModule } from "../types";
import { parseCopilotStdoutLine } from "../../../../packages/adapters/copilot-cli/src/ui";
import { CopilotCliConfigFields } from "./config-fields";
import { buildCopilotCliConfig } from "../../../../packages/adapters/copilot-cli/src/ui";

export const copilotCliUIAdapter: UIAdapterModule = {
  type: "copilot_cli",
  label: "GitHub Copilot (local)",
  parseStdoutLine: parseCopilotStdoutLine,
  ConfigFields: CopilotCliConfigFields,
  buildAdapterConfig: buildCopilotCliConfig,
};
