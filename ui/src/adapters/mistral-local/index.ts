import type { UIAdapterModule } from "../types";
import { parseMistralStdoutLine } from "@paperclipai/adapter-mistral-local/ui";
import { buildMistralLocalConfig } from "@paperclipai/adapter-mistral-local/ui";
import { MistralLocalConfigFields } from "./config-fields";

export const mistralLocalUIAdapter: UIAdapterModule = {
  type: "mistral_local",
  label: "Mistral (local)",
  parseStdoutLine: parseMistralStdoutLine,
  ConfigFields: MistralLocalConfigFields,
  buildAdapterConfig: buildMistralLocalConfig,
};
