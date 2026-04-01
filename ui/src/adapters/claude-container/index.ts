import type { UIAdapterModule } from "../types";
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { ClaudeContainerConfigFields } from "./config-fields";
import { buildClaudeContainerConfig } from "./build-config";

export const claudeContainerUIAdapter: UIAdapterModule = {
  type: "claude_container",
  label: "Claude Code (container)",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: ClaudeContainerConfigFields,
  buildAdapterConfig: buildClaudeContainerConfig,
};
