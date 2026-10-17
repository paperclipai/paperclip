import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildConfig,
  createOpenRouterStdoutParser,
  parseOpenRouterStdoutLine,
} from "@paperclipai/adapter-openrouter/ui";

export const openRouterUIAdapter: UIAdapterModule = {
  type: "openrouter",
  label: "OpenRouter",
  parseStdoutLine: parseOpenRouterStdoutLine,
  createStdoutParser: createOpenRouterStdoutParser,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildConfig,
};