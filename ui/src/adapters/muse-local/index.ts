import type { UIAdapterModule } from "../types";
import { buildMuseLocalConfig, createMuseStdoutParser, parseMuseStdoutLine } from "@paperclipai/adapter-muse-local/ui";
import { MuseLocalConfigFields } from "./config-fields";

export const museLocalUIAdapter: UIAdapterModule = {
  type: "muse_local",
  label: "Muse Code",
  parseStdoutLine: parseMuseStdoutLine,
  createStdoutParser: createMuseStdoutParser,
  ConfigFields: MuseLocalConfigFields,
  buildAdapterConfig: buildMuseLocalConfig,
};
