import type { UIAdapterModule } from "../types";
import { SchemaConfigFields } from "../schema-config-fields";
import {
  buildOpenAiCompatibleConfig,
  parseOpenAiCompatibleStdoutLine,
} from "@paperclipai/adapter-openai-compatible/ui";

export const openAiCompatibleUIAdapter: UIAdapterModule = {
  type: "openai_compatible",
  label: "OpenAI-compatible API",
  parseStdoutLine: parseOpenAiCompatibleStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildOpenAiCompatibleConfig,
};
