import type { UIAdapterModule } from "../types";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
// Auto rotation delegates to the Claude or Codex CLI at runtime; reuse the
// Claude transcript parser for display (the common case). Codex runs still
// render usefully via the generic line handling.
import { parseClaudeStdoutLine } from "@paperclipai/adapter-claude-local/ui";
import { AutoRotationConfigFields } from "./config-fields";

function buildAutoRotationConfig(_values: CreateConfigValues): Record<string, unknown> {
  // No required config — the balancer decides the provider/account per run.
  return {};
}

export const autoRotationUIAdapter: UIAdapterModule = {
  type: "auto_rotation",
  label: "Auto rotation",
  parseStdoutLine: parseClaudeStdoutLine,
  ConfigFields: AutoRotationConfigFields,
  buildAdapterConfig: buildAutoRotationConfig,
};
