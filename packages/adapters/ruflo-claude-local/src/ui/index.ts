import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildClaudeLocalConfig, parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";

export { parseClaudeStdoutLine };

export function buildRufloClaudeLocalConfig(values: CreateConfigValues) {
  return {
    ...buildClaudeLocalConfig(values),
    rufloRequired: true,
    rufloMcpServerName: "ruflo",
  };
}
