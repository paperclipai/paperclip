import type { UIAdapterModule } from "../types";
import { parseAcpxStdoutLine, buildAcpxLocalConfig } from "@paperclipai/adapter-acpx-local/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const acpxLocalUIAdapter: UIAdapterModule = {
  type: "acpx_local",
  label: "ACPX (local)",
  parseStdoutLine: parseAcpxStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildAcpxLocalConfig,
};
