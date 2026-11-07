import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseHermesStdoutLine, buildHermesConfig } from "@paperclipai/hermes-paperclip-adapter/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  get label() { return t("agent-config:hermes_3e06620"); },
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
