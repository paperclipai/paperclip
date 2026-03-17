import type { UIAdapterModule } from "../types";
import { parseAmpStdoutLine } from "@paperclipai/adapter-amp-local/ui";
import { AmpLocalConfigFields } from "./config-fields";
import { buildAmpLocalConfig } from "@paperclipai/adapter-amp-local/ui";

export const ampLocalUIAdapter: UIAdapterModule = {
  type: "amp_local",
  label: "Amp (local)",
  parseStdoutLine: parseAmpStdoutLine,
  ConfigFields: AmpLocalConfigFields,
  buildAdapterConfig: buildAmpLocalConfig,
};
