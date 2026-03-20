import type { UIAdapterModule } from "../types";
import { parseStdoutLine } from "@paperclipai/adapter-kiro-local/ui";
import { KiroLocalConfigFields } from "./config-fields";
import { buildAdapterConfig } from "@paperclipai/adapter-kiro-local/ui";

export const kiroLocalUIAdapter: UIAdapterModule = {
  type: "kiro_local",
  label: "Kiro (local)",
  parseStdoutLine,
  ConfigFields: KiroLocalConfigFields,
  buildAdapterConfig,
};
