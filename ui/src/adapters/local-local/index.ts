import type { UIAdapterModule } from "../types";
import { parseLocalLocalStdoutLine } from "@paperclipai/adapter-local-local/ui";
import { LocalLocalConfigFields } from "./config-fields";
import { buildLocalLocalConfig } from "@paperclipai/adapter-local-local/ui";

export const localLocalUIAdapter: UIAdapterModule = {
  type: "local_local",
  label: "Local (Claude + LM Studio)",
  parseStdoutLine: parseLocalLocalStdoutLine,
  ConfigFields: LocalLocalConfigFields,
  buildAdapterConfig: buildLocalLocalConfig,
};
