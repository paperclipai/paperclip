import type { EnvBinding } from "@paperclipai/shared";
import { DEFAULT_CLAUDE_LOCAL_MODEL } from "@paperclipai/adapter-claude-local";

/**
 * Name the model that a claude_local agent with no explicit model uses.
 * The order matches `resolveClaudeModel`: the agent's own ANTHROPIC_MODEL
 * wins, the host ANTHROPIC_MODEL applies only to runs on the Paperclip host,
 * and the built-in default applies last. Returns null when a secret supplies
 * the agent's ANTHROPIC_MODEL, because the form cannot read that value.
 */
export function claudeDefaultModelName(input: {
  agentEnv?: Record<string, EnvBinding> | null;
  hostModel?: string | null;
  runsOnHost: boolean;
}): string | null {
  const binding = input.agentEnv?.ANTHROPIC_MODEL;
  if (binding !== undefined) {
    const value = typeof binding === "string" ? binding : binding.type === "plain" ? binding.value : null;
    if (value === null) return null;
    return value.trim() || DEFAULT_CLAUDE_LOCAL_MODEL;
  }
  const hostModel = input.runsOnHost ? input.hostModel?.trim() : "";
  return hostModel || DEFAULT_CLAUDE_LOCAL_MODEL;
}
