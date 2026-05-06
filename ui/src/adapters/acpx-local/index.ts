import i18n from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseAcpxStdoutLine, buildAcpxLocalConfig } from "@paperclipai/adapter-acpx-local/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const acpxLocalUIAdapter: UIAdapterModule = {
  type: "acpx_local",
  label: i18n.t("adapters.acpx-local.label"),
  parseStdoutLine: parseAcpxStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildAcpxLocalConfig,
};
