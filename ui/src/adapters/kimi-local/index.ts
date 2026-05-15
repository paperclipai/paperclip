import type { UIAdapterModule } from "../types";
import { parseKimiStdoutLine } from "@paperclipai/adapter-kimi-local/ui";
import { createKimiStdoutParser } from "./parse-stdout";
import { KimiLocalConfigFields } from "./config-fields";
import { buildKimiLocalConfig } from "@paperclipai/adapter-kimi-local/ui";

export const kimiLocalUIAdapter: UIAdapterModule = {
  type: "kimi_local",
  label: "Kimi (Moonshot AI)",
  parseStdoutLine: parseKimiStdoutLine,
  createStdoutParser: createKimiStdoutParser,
  ConfigFields: KimiLocalConfigFields,
  buildAdapterConfig: buildKimiLocalConfig,
};
