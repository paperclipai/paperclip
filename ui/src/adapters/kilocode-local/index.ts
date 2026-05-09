import type { UIAdapterModule } from "../types";
import { parseKilocodeStdoutLine } from "@paperclipai/adapter-kilocode-local/ui";
import { KilocodeLocalConfigFields } from "./config-fields";
import { buildKilocodeLocalConfig } from "@paperclipai/adapter-kilocode-local/ui";

export const kilocodeLocalUIAdapter: UIAdapterModule = {
  type: "kilocode_local",
  label: "Kilocode CLI (local)",
  parseStdoutLine: parseKilocodeStdoutLine,
  ConfigFields: KilocodeLocalConfigFields,
  buildAdapterConfig: buildKilocodeLocalConfig,
};
