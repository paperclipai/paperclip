import type { UIAdapterModule } from "../types";
import { buildT3CodeLocalConfig, parseT3CodeStdoutLine } from "@paperclipai/adapter-t3code-local/ui";
import { T3CodeLocalConfigFields } from "./config-fields";

export const t3codeLocalUIAdapter: UIAdapterModule = {
  type: "t3code_local",
  label: "T3 Code",
  parseStdoutLine: parseT3CodeStdoutLine,
  ConfigFields: T3CodeLocalConfigFields,
  buildAdapterConfig: buildT3CodeLocalConfig,
};
