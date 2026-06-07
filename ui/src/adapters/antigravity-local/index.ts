import type { UIAdapterModule } from "../types";
import { parseAntigravityStdoutLine } from "@paperclipai/adapter-antigravity-local/ui";
import { AntigravityLocalConfigFields } from "./config-fields";
import { buildAntigravityLocalConfig } from "@paperclipai/adapter-antigravity-local/ui";

export const antigravityLocalUIAdapter: UIAdapterModule = {
  type: "antigravity_local",
  label: "Antigravity CLI (local)",
  parseStdoutLine: parseAntigravityStdoutLine,
  ConfigFields: AntigravityLocalConfigFields,
  buildAdapterConfig: buildAntigravityLocalConfig,
};
