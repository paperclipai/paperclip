import type { UIAdapterModule } from "../types";
import { formatMessage } from "../../i18n";
import { getRuntimeLocale } from "../../i18n/runtime";
import { parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { CodexLocalConfigFields } from "./config-fields";
import { buildCodexLocalConfig } from "@paperclipai/adapter-codex-local/ui";

export const codexLocalUIAdapter: UIAdapterModule = {
  type: "codex_local",
  label: formatMessage(getRuntimeLocale(), "agentConfig.adapterLabels.codexLocal"),
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildCodexLocalConfig,
};
