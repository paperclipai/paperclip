import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseGeminiStdoutLine } from "@paperclipai/adapter-gemini-local/ui";
import { GeminiLocalConfigFields } from "./config-fields";
import { buildGeminiLocalConfig } from "@paperclipai/adapter-gemini-local/ui";

export const geminiLocalUIAdapter: UIAdapterModule = {
  type: "gemini_local",
  get label() { return t("agent-config:geminiCli_4844115"); },
  parseStdoutLine: parseGeminiStdoutLine,
  ConfigFields: GeminiLocalConfigFields,
  buildAdapterConfig: buildGeminiLocalConfig,
};
