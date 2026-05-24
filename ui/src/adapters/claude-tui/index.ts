import type { UIAdapterModule } from "../types";
import { parseClaudeTuiStdoutLine, buildClaudeTuiConfig } from "@paperclipai/adapter-claude-tui/ui";
import { SchemaConfigFields } from "../schema-config-fields";

export const claudeTuiUIAdapter: UIAdapterModule = {
  type: "claude_tui",
  label: "Claude Code (TUI driver)",
  parseStdoutLine: parseClaudeTuiStdoutLine,
  ConfigFields: SchemaConfigFields,
  buildAdapterConfig: buildClaudeTuiConfig,
};
