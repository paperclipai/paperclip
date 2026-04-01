import type { UIAdapterModule } from "../types";
import { formatMessage } from "../../i18n";
import { getRuntimeLocale } from "../../i18n/runtime";
import { parseProcessStdoutLine } from "./parse-stdout";
import { ProcessConfigFields } from "./config-fields";
import { buildProcessConfig } from "./build-config";

export const processUIAdapter: UIAdapterModule = {
  type: "process",
  label: formatMessage(getRuntimeLocale(), "agentConfig.adapterLabels.process"),
  parseStdoutLine: parseProcessStdoutLine,
  ConfigFields: ProcessConfigFields,
  buildAdapterConfig: buildProcessConfig,
};
