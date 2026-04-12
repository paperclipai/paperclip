import type { UIAdapterModule } from "../types";
import { parseKimiStdoutLine } from "@paperclipai/adapter-kimi-local/ui";
import { KimiLocalConfigFields } from "./config-fields";
import { buildKimiLocalConfig } from "@paperclipai/adapter-kimi-local/ui";

export const kimiLocalUIAdapter: UIAdapterModule = {
  type: "kimi_local",
  label: "Kimi (local)",
  parseStdoutLine: parseKimiStdoutLine,
  ConfigFields: KimiLocalConfigFields,
  buildAdapterConfig: buildKimiLocalConfig,
};
