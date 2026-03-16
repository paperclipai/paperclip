import type { UIAdapterModule } from "../types";
import { parseHermesStdoutLine, buildHermesConfig } from "hermes-paperclip-adapter/ui";
import { HermesLocalConfigFields } from "./config-fields";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesConfig,
};