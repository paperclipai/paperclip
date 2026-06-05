import type { UIAdapterModule } from "../types";
import { buildLocalConfig, parseLocalStdoutLine } from "@paperclipai/adapter-local/ui";
import { LocalConfigFields } from "./config-fields";

export const localUIAdapter: UIAdapterModule = {
  type: "local",
  label: "Local LLM",
  parseStdoutLine: parseLocalStdoutLine,
  ConfigFields: LocalConfigFields,
  buildAdapterConfig: buildLocalConfig,
};
