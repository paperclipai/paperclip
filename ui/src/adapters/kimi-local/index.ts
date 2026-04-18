import type { UIAdapterModule } from "../types";
import { parseKimiStdoutLine } from "@paperclipai/adapter-kimi-local/ui";
import { KimiLocalConfigFields } from "./config-fields";
import { buildKimiConfig } from "@paperclipai/adapter-kimi-local/ui";

export const kimiLocalUIAdapter: UIAdapterModule = {
  type: "kimi_local",
  label: "Kimi Code CLI (local)",
  parseStdoutLine: parseKimiStdoutLine,
  ConfigFields: KimiLocalConfigFields,
  buildAdapterConfig: buildKimiConfig,
};
