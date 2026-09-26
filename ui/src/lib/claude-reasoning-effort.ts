import {
  claudeLocalReasoningEffortsForModel,
  DEFAULT_CLAUDE_LOCAL_MODEL,
} from "@paperclipai/adapter-claude-local";
import type { EnvBinding } from "@paperclipai/shared";

const CLAUDE_REASONING_EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
};

/**
 * Read a literal env value out of an EnvBinding map. Secret-ref bindings are
 * intentionally opaque client-side, so those are skipped rather than treated
 * as blank — same "can't know, don't guess" rule as everywhere else secrets
 * are handled in the UI.
 */
function literalEnvValue(env: Record<string, EnvBinding> | null | undefined, key: string): string {
  const binding = env?.[key];
  if (typeof binding === "string") return binding.trim();
  if (binding && typeof binding === "object" && binding.type === "plain") return binding.value.trim();
  return "";
}

/**
 * Effort choices the selected Claude model actually accepts. Current Opus,
 * Sonnet 5 and Fable models add xhigh/max on top of low/medium/high, the 4.6
 * models add max only, and Haiku models expose no effort tier at all — so the
 * list is model-derived rather than a fixed low/medium/high triple.
 *
 * A blank stored `model` falls back to ANTHROPIC_MODEL from `env` before the
 * adapter default, mirroring the adapter's own resolveClaudeModel precedence —
 * otherwise an agent that selects Haiku only via ANTHROPIC_MODEL would still
 * be shown Opus 5's X-High/Max tiers here.
 */
export function claudeReasoningEffortOptions(
  model: string | null | undefined,
  defaultLabel = "Default",
  env?: Record<string, EnvBinding> | null,
) {
  const configuredModel = typeof model === "string" ? model.trim() : "";
  const resolvedModel = configuredModel || literalEnvValue(env, "ANTHROPIC_MODEL") || DEFAULT_CLAUDE_LOCAL_MODEL;
  return [
    { value: "", label: defaultLabel },
    ...claudeLocalReasoningEffortsForModel(resolvedModel).map((value) => ({
      value,
      label: CLAUDE_REASONING_EFFORT_LABELS[value] ?? value,
    })),
  ];
}
