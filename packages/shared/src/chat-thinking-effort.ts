/**
 * Adapter-specific reasoning effort values that may be selected for exactly
 * one board chat reply. "Default" is represented by no override at all, so
 * it preserves the assignee's saved adapter configuration.
 */
export type ChatThinkingEffortAdapterType = "codex_local" | "claude_local" | "opencode_local";

export type ChatThinkingEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra";

export const CHAT_THINKING_EFFORT_OPTIONS_BY_ADAPTER: Record<
  ChatThinkingEffortAdapterType,
  readonly ChatThinkingEffort[]
> = {
  codex_local: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  claude_local: ["low", "medium", "high", "xhigh", "max"],
  opencode_local: ["minimal", "low", "medium", "high", "xhigh", "max"],
};

export const CHAT_THINKING_EFFORT_ADAPTER_CONFIG_KEYS: Record<
  ChatThinkingEffortAdapterType,
  "modelReasoningEffort" | "effort" | "variant"
> = {
  codex_local: "modelReasoningEffort",
  claude_local: "effort",
  opencode_local: "variant",
};

export function chatThinkingEffortOptionsForAdapter(
  adapterType: unknown,
): readonly ChatThinkingEffort[] {
  if (!isChatThinkingEffortAdapterType(adapterType)) return [];
  return CHAT_THINKING_EFFORT_OPTIONS_BY_ADAPTER[adapterType];
}

export function chatThinkingEffortAdapterConfigKey(
  adapterType: unknown,
): "modelReasoningEffort" | "effort" | "variant" | null {
  if (!isChatThinkingEffortAdapterType(adapterType)) return null;
  return CHAT_THINKING_EFFORT_ADAPTER_CONFIG_KEYS[adapterType];
}

export function isChatThinkingEffortSupported(
  adapterType: unknown,
  effort: unknown,
): effort is ChatThinkingEffort {
  return typeof effort === "string" && chatThinkingEffortOptionsForAdapter(adapterType).includes(
    effort as ChatThinkingEffort,
  );
}

export function formatChatThinkingEffort(effort: string): string {
  switch (effort) {
    case "xhigh":
      return "X-High";
    case "none":
      return "None";
    default:
      return effort.length > 0 ? `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}` : "Default";
  }
}

function isChatThinkingEffortAdapterType(value: unknown): value is ChatThinkingEffortAdapterType {
  return value === "codex_local" || value === "claude_local" || value === "opencode_local";
}
