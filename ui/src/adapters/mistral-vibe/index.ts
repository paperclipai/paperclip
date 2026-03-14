import type { UIAdapterModule } from "../types";
import { parseMistralStdoutLine } from "@paperclipai/adapter-mistral-vibe/ui";
import { MistralVibeConfigFields } from "./config-fields";
import { buildMistralVibeConfig } from "@paperclipai/adapter-mistral-vibe/ui";

export const mistralVibeUIAdapter: UIAdapterModule = {
  type: "mistral_vibe",
  label: "Mistral Vibe",
  parseStdoutLine: parseMistralStdoutLine,
  ConfigFields: MistralVibeConfigFields,
  buildAdapterConfig: buildMistralVibeConfig,
};