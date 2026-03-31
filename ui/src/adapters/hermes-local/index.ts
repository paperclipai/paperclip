import type { UIAdapterModule } from "../types";
import { parseHermesStdoutLine } from "hermes-paperclip-adapter/ui";
import { HermesLocalConfigFields } from "./config-fields";
import { buildHermesConfig } from "hermes-paperclip-adapter/ui";

export const hermesLocalUIAdapter: UIAdapterModule = {
  type: "hermes_local",
  label: "Hermes Agent",
  parseStdoutLine: parseHermesStdoutLine,
  ConfigFields: HermesLocalConfigFields,
  buildAdapterConfig: buildHermesConfig,
};
