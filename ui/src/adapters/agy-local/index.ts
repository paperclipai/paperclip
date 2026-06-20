import type { UIAdapterModule } from "../types";
import { parseAgyStdoutLine } from "@paperclipai/adapter-agy-local/ui";
import { AgyLocalConfigFields } from "./config-fields";
import { buildAgyLocalConfig } from "@paperclipai/adapter-agy-local/ui";

export const agyLocalUIAdapter: UIAdapterModule = {
  type: "agy_local",
  label: "Antigravity (agy)",
  parseStdoutLine: parseAgyStdoutLine,
  ConfigFields: AgyLocalConfigFields,
  buildAdapterConfig: buildAgyLocalConfig,
};
