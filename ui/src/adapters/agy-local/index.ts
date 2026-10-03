import type { UIAdapterModule } from "../types";
import { parseAgyStdoutLine, buildAgyConfig } from "@paperclipai/adapter-agy-local/ui";
import { AgyLocalConfigFields } from "./config-fields";

export const agyLocalUIAdapter: UIAdapterModule = {
  type: "agy_local",
  label: "Antigravity (agy)",
  parseStdoutLine: parseAgyStdoutLine,
  ConfigFields: AgyLocalConfigFields,
  buildAdapterConfig: buildAgyConfig,
};
