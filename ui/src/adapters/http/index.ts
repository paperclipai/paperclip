import type { UIAdapterModule } from "../types";
import { formatMessage } from "../../i18n";
import { getRuntimeLocale } from "../../i18n/runtime";
import { parseHttpStdoutLine } from "./parse-stdout";
import { HttpConfigFields } from "./config-fields";
import { buildHttpConfig } from "./build-config";

export const httpUIAdapter: UIAdapterModule = {
  type: "http",
  label: formatMessage(getRuntimeLocale(), "agentConfig.adapterLabels.http"),
  parseStdoutLine: parseHttpStdoutLine,
  ConfigFields: HttpConfigFields,
  buildAdapterConfig: buildHttpConfig,
};
