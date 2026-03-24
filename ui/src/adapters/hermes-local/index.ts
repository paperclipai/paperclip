import type { UIAdapterModule } from "../types";
import { parseHermesStdoutLine } from "./parse-stdout";
import { HermesLocalConfigFields } from "./config-fields";
import { buildHermesConfig } from "./build-config";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent (local)",
  mcpSupported: true,
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
