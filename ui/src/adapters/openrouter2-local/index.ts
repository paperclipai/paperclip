import type { UIAdapterModule } from "../types";
import { parseOpenRouter2StdoutLine } from "@paperclipai/adapter-openrouter2-local/ui";
import { buildOpenRouter2LocalConfig } from "@paperclipai/adapter-openrouter2-local/ui";
import { OpenRouter2LocalConfigFields } from "./config-fields";

export const openRouter2LocalUIAdapter: UIAdapterModule = {
  type: "openrouter2_local",
  label: "OpenRouter2",
  parseStdoutLine: parseOpenRouter2StdoutLine,
  ConfigFields: OpenRouter2LocalConfigFields,
  buildAdapterConfig: buildOpenRouter2LocalConfig,
};
