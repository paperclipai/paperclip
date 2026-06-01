import type { UIAdapterModule } from "../types";
import { parseClaudeTuiStdoutLine, buildClaudeTuiConfig } from "@paperclipai/adapter-claude-tui/ui";
// claude_tui shares claude_local's config surface (cwd, instructions, model,
// effort, chrome, env, …), so it reuses the same config-fields component.
import { ClaudeLocalConfigFields } from "../claude-local/config-fields";

export const claudeTuiUIAdapter: UIAdapterModule = {
  type: "claude_tui",
  label: "Claude Code (TUI driver)",
  parseStdoutLine: parseClaudeTuiStdoutLine,
  ConfigFields: ClaudeLocalConfigFields,
  buildAdapterConfig: buildClaudeTuiConfig,
};
