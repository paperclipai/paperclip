import type { UIAdapterModule } from "../types";
import { parseHermesProfileStdoutLine } from "@paperclipai/adapter-hermes-profile/ui";
import { buildHermesProfileConfig } from "@paperclipai/adapter-hermes-profile/ui";
import { HermesProfileConfigFields } from "./config-fields";

export const hermesProfileUIAdapter: UIAdapterModule = {
  type: "hermes_profile",
  label: "Hermes Profile",
  parseStdoutLine: parseHermesProfileStdoutLine,
  ConfigFields: HermesProfileConfigFields,
  buildAdapterConfig: buildHermesProfileConfig,
};
