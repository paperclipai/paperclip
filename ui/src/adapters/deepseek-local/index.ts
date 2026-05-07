import type { UIAdapterModule } from "../types";
import {
  buildDeepseekLocalConfig,
  parseDeepseekStdoutLine,
} from "@paperclipai/adapter-deepseek-local/ui";
import { DeepseekLocalConfigFields } from "./config-fields";

export const deepseekLocalUIAdapter: UIAdapterModule = {
  type: "deepseek_local",
  label: "DeepSeek",
  parseStdoutLine: parseDeepseekStdoutLine,
  ConfigFields: DeepseekLocalConfigFields,
  buildAdapterConfig: buildDeepseekLocalConfig,
};
