import type { UIAdapterModule } from "../types";
import { parseOpenRouterStdoutLine } from "@paperclipai/adapter-openrouter-local/ui";
import { buildOpenRouterLocalConfig } from "@paperclipai/adapter-openrouter-local/ui";
import { OpenRouterLocalConfigFields } from "./config-fields";

export const openRouterLocalUIAdapter: UIAdapterModule = {
  type: "openrouter_local",
  label: "OpenRouter",
  parseStdoutLine: parseOpenRouterStdoutLine,
  ConfigFields: OpenRouterLocalConfigFields,
  buildAdapterConfig: buildOpenRouterLocalConfig,
};
