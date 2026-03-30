import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildClaudeLocalConfig } from "@paperclipai/adapter-claude-local/ui";

export function buildLocalLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  // Start with the Claude config (handles cwd, model, env, workspace, etc.)
  const ac = buildClaudeLocalConfig(v);

  // Add local_local specific fields
  // localBaseUrl is passed via the envVars or a custom field
  // The UI will set it in the config directly
  return ac;
}
