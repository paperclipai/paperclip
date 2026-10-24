import type { UIAdapterModule } from "../types";
import { parseMuseCodeStdoutLine, createMuseCodeStdoutParser } from "@paperclipai/adapter-muse-code-local/ui";
import { MuseCodeLocalConfigFields } from "./config-fields";
import { buildMuseCodeLocalConfig } from "@paperclipai/adapter-muse-code-local/ui";

export const museCodeLocalUIAdapter: UIAdapterModule = {
  type: "muse_code_local",
  label: "Muse",
  parseStdoutLine: parseMuseCodeStdoutLine,
  createStdoutParser: createMuseCodeStdoutParser,
  ConfigFields: MuseCodeLocalConfigFields,
  buildAdapterConfig: buildMuseCodeLocalConfig,
};
