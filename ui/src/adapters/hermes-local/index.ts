import type { UIAdapterModule } from "../types";
import { formatMessage } from "../../i18n";
import { getRuntimeLocale } from "../../i18n/runtime";
import { parseHermesStdoutLine } from "hermes-paperclip-adapter/ui";
import { HermesLocalConfigFields } from "./config-fields";
import { buildHermesConfig } from "hermes-paperclip-adapter/ui";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: formatMessage(getRuntimeLocale(), "agentConfig.adapterLabels.hermesLocal"),
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
