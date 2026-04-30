import type { UIAdapterModule } from "../types";
import { parseAiderStdoutLine } from "./parse-stdout";
import { AiderLocalConfigFields } from "./config-fields";
import { buildAiderLocalConfig } from "./build-config";

export const aiderLocalUIAdapter: UIAdapterModule = {
  type: "aider_local",
  label: "Aider (local)",
  parseStdoutLine: parseAiderStdoutLine,
  ConfigFields: AiderLocalConfigFields,
  buildAdapterConfig: buildAiderLocalConfig,
};
