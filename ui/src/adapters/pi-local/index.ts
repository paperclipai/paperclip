import type { UIAdapterModule } from "../types";
import {
  buildPiLocalConfig,
  createPiStdoutParser,
  parsePiStdoutLine,
} from "@paperclipai/adapter-pi-local/ui";
import { PiLocalConfigFields } from "./config-fields";

export const piLocalUIAdapter: UIAdapterModule = {
  type: "pi_local",
  label: "Pi",
  parseStdoutLine: parsePiStdoutLine,
  createStdoutParser: createPiStdoutParser,
  ConfigFields: PiLocalConfigFields,
  buildAdapterConfig: buildPiLocalConfig,
};
