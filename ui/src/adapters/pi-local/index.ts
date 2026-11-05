import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parsePiStdoutLine } from "@paperclipai/adapter-pi-local/ui";
import { PiLocalConfigFields } from "./config-fields";
import { buildPiLocalConfig } from "@paperclipai/adapter-pi-local/ui";

export const piLocalUIAdapter: UIAdapterModule = {
  type: "pi_local",
  get label() { return t("agent-config:pi_a134388"); },
  parseStdoutLine: parsePiStdoutLine,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPiLocalConfig,
};
