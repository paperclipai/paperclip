/**
 * Adapter types shipped with Paperclip. External plugins may override these;
 * removing the override restores the built-in version.
 */
export const BUILTIN_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "hermes_local",
  "process",
  "http",
]);
