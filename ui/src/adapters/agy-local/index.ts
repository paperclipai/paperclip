import type { UIAdapterModule } from "../types";
import { createAgyStdoutParser, parseAgyStdoutLine, buildAgyLocalConfig } from "@paperclipai/adapter-agy-local/ui";
import { AgyLocalConfigFields } from "./config-fields";

export const agyLocalUIAdapter: UIAdapterModule = {
  type: "agy_local",
  label: "Antigravity CLI (agy)",
  parseStdoutLine: parseAgyStdoutLine,
  createStdoutParser: createAgyStdoutParser,
  ConfigFields: AgyLocalConfigFields,
  buildAdapterConfig: buildAgyLocalConfig,
};
