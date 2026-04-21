import type { UIAdapterModule } from "../types";
import { parseAuggieStdoutLine } from "@paperclipai/adapter-auggie-local/ui";
import { AuggieLocalConfigFields } from "./config-fields";
import { buildAuggieLocalConfig } from "@paperclipai/adapter-auggie-local/ui";

export const auggieLocalUIAdapter: UIAdapterModule = {
  type: "auggie_local",
  label: "Auggie CLI (local)",
  parseStdoutLine: parseAuggieStdoutLine,
  ConfigFields: AuggieLocalConfigFields,
  buildAdapterConfig: buildAuggieLocalConfig,
};
