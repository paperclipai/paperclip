import { t } from "@/i18n";
import type { UIAdapterModule } from "../types";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { CodexLocalConfigFields, buildCodexRunnerConfig } from "./config-fields";

export const codexLocalUIAdapter: UIAdapterModule = {
  type: "codex_local",
  get label() { return t("agent-config:codex_2c5d5b8"); },
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildCodexRunnerConfig,
};
