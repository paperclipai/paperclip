/** Explicit evaluation selections, not runtime defaults or model allowlists. */
export const ACPX_QUALIFICATION_MODELS = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
  grok: "grok-4.7",
  pi: "openrouter/deepseek/deepseek-v4-flash-0731",
} as const;
