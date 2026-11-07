import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseProcessStdoutLine } from "./parse-stdout";
import { ProcessConfigFields } from "./config-fields";
import { buildProcessConfig } from "./build-config";

export const processUIAdapter: UIAdapterModule = {
  type: "process",
  get label() { return t("agent-config:shellProcess_ae68bf1"); },
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: ProcessConfigFields,
  buildAdapterConfig: buildProcessConfig,
};
