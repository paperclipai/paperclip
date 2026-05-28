/**
 * Adapter types shipped with Paperclip. External plugins must not replace these.
 */
export const BUILTIN_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "google_adk",
  "openclaw_gateway",
  "otto_agent",
  "clickup_agent_ref",
  "opencode_local",
  "pi_local",
  "hermes_local",
  "process",
  "http",
]);
