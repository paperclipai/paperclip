import type { UIAdapterModule } from "../types";
import { parseAmplifierLocalStdoutLine } from "@paperclipai/adapter-amplifier-local/ui";
import { AmplifierLocalConfigFields } from "./config-fields";
import { buildAmplifierLocalConfig } from "@paperclipai/adapter-amplifier-local/ui";

export const amplifierLocalUIAdapter: UIAdapterModule = {
  type: "amplifier_local",
  label: "Amplifier (local)",
  parseStdoutLine: parseAmplifierLocalStdoutLine,
  ConfigFields: AmplifierLocalConfigFields,
  buildAdapterConfig: buildAmplifierLocalConfig,
};
