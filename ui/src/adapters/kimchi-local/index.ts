import type { UIAdapterModule } from "../types";
import { parseKimchiStdoutLine } from "@paperclipai/adapter-kimchi-local/ui";
import { KimchiLocalConfigFields } from "./config-fields";
import { buildKimchiLocalConfig } from "@paperclipai/adapter-kimchi-local/ui";

export const kimchiLocalUIAdapter: UIAdapterModule = {
  type: "kimchi_local",
  label: "Kimchi",
  parseStdoutLine: parseKimchiStdoutLine,
  ConfigFields: KimchiLocalConfigFields,
  buildAdapterConfig: buildKimchiLocalConfig,
};
