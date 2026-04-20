const LEGACY_CLAUDE_MODEL_ALIASES: Record<string, string> = {
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-haiku-4.6": "claude-haiku-4-6",
};

export function normalizeClaudeModelId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const withoutProvider = trimmed.startsWith("anthropic/")
    ? trimmed.slice("anthropic/".length)
    : trimmed;

  return LEGACY_CLAUDE_MODEL_ALIASES[withoutProvider] ?? withoutProvider;
}
