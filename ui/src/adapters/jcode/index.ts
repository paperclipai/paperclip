import type { UIAdapterModule } from "../types";
import { parseJcodeStdoutLine } from "@paperclipai/adapter-jcode-local/ui";
import { JcodeLocalConfigFields } from "./config-fields";
import { buildJcodeLocalConfig } from "@paperclipai/adapter-jcode-local/ui";

export const jcodeUIAdapter: UIAdapterModule = {
  type: "jcode_local",
  label: "JCode",
  parseStdoutLine: parseJcodeStdoutLine,
  ConfigFields: JcodeLocalConfigFields,
  buildAdapterConfig: buildJcodeLocalConfig,
};
