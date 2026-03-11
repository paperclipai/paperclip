import type { UIAdapterModule } from "../types";
import { parseQwenStdoutLine } from "@paperclipai/adapter-qwen-local/ui";
import { QwenLocalConfigFields } from "./config-fields";
import { buildQwenLocalConfig } from "@paperclipai/adapter-qwen-local/ui";

export const qwenLocalUIAdapter: UIAdapterModule = {
  type: "qwen_local",
  label: "Qwen Code (local)",
  parseStdoutLine: parseQwenStdoutLine,
  ConfigFields: QwenLocalConfigFields,
  buildAdapterConfig: buildQwenLocalConfig,
};
