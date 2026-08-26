import { buildPaperclipRunnerConfig, parseCodexStdoutLine } from "@paperclipai/adapter-codex-local/ui";
import { CodexLocalConfigFields } from "../codex-local/config-fields";
import type { UIAdapterModule } from "../types";

export const paperclipRunnerUIAdapter: UIAdapterModule = {
  type: "paperclip_runner",
  label: "Paperclip Runner",
  parseStdoutLine: parseCodexStdoutLine,
  ConfigFields: CodexLocalConfigFields,
  buildAdapterConfig: buildPaperclipRunnerConfig,
};
