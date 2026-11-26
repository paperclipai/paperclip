import type { UIAdapterModule } from "../types";
import { parseAgyStdoutLine, buildAgyLocalConfig } from "@paperclipai/adapter-agy-local/ui";
import { AgyLocalConfigFields } from "./config-fields";

export const agyLocalUIAdapter: UIAdapterModule = {
  type: "agy_local",
  label: "Antigravity CLI (agy)",
  parseStdoutLine: parseAgyStdoutLine,
  ConfigFields: AgyLocalConfigFields,
  buildAdapterConfig: buildAgyLocalConfig,
};
