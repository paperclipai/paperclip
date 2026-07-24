import type { UIAdapterModule } from "../types";
import { parseCommandCodeStdoutLine } from "@paperclipai/adapter-commandcode-local/ui";
import { buildCommandCodeLocalConfig } from "@paperclipai/adapter-commandcode-local/ui";
import { CommandCodeLocalConfigFields } from "./config-fields";

export const commandCodeLocalUIAdapter: UIAdapterModule = {
  type: "commandcode_local",
  label: "CommandCode (local)",
  parseStdoutLine: parseCommandCodeStdoutLine,
  ConfigFields: CommandCodeLocalConfigFields,
  buildAdapterConfig: buildCommandCodeLocalConfig,
};
