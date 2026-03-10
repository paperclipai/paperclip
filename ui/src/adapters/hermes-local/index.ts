import type { UIAdapterModule } from "../types";
import { parseHermesStdoutLine } from "@paperclipai/adapter-hermes-local/ui";
import { HermesLocalConfigFields } from "./config-fields";
import { buildHermesLocalConfig } from "@paperclipai/adapter-hermes-local/ui";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes (local)",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesLocalConfig,
};
