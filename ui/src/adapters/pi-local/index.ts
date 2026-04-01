import type { UIAdapterModule } from "../types";
import { formatMessage } from "../../i18n";
import { getRuntimeLocale } from "../../i18n/runtime";
import { parsePiStdoutLine } from "@paperclipai/adapter-pi-local/ui";
import { PiLocalConfigFields } from "./config-fields";
import { buildPiLocalConfig } from "@paperclipai/adapter-pi-local/ui";

export const piLocalUIAdapter: UIAdapterModule = {
  type: "pi_local",
  label: formatMessage(getRuntimeLocale(), "agentConfig.adapterLabels.piLocal"),
  parseStdoutLine: parsePiStdoutLine,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPiLocalConfig,
};
