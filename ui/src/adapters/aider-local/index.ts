import type { UIAdapterModule } from "../types";
import {
  parseAiderStdoutLine,
  buildAiderLocalConfig,
} from "@paperclipai/adapter-aider-local/ui";
import { AiderLocalConfigFields } from "./config-fields";

export const aiderLocalUIAdapter: UIAdapterModule = {
  type: "aider_local",
  label: "Aider",
  parseStdoutLine: parseAiderStdoutLine,
  ConfigFields: AiderLocalConfigFields,
  buildAdapterConfig: buildAiderLocalConfig,
};
