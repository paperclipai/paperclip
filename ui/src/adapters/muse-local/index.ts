import type { UIAdapterModule } from "../types.js";
import { parseMuseStdoutLine, createMuseStdoutParser, buildMuseLocalConfig } from "@paperclipai/adapter-muse-local/ui";
import { MuseLocalConfigFields } from "./config-fields.js";

export const museLocalUIAdapter: UIAdapterModule = {
  type: "muse_local",
  label: "Muse Code",
  parseStdoutLine: parseMuseStdoutLine,
  createStdoutParser: createMuseStdoutParser,
  ConfigFields: MuseLocalConfigFields,
  buildAdapterConfig: buildMuseLocalConfig,
};
