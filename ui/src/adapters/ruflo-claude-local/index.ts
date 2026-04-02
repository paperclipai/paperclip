import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine, buildRufloClaudeLocalConfig } from "@paperclipai/adapter-ruflo-claude-local/ui";
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";

export const rufloClaudeLocalUIAdapter: UIAdapterModule = {
  type: "ruflo_claude_local",
  label: "Claude Code + Ruflo (local)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeLocalConfigFields,
  buildAdapterConfig: buildRufloClaudeLocalConfig,
};
