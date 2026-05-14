/**
 * Helpers for local CLI adapters (`*_local` Paperclip adapter types).
 */
/** True for `codex_local` (OpenAI Codex CLI adapter type). */
export function isCodexCliAdapterType(adapterType: string): boolean {
  return adapterType === "codex_local";
}

/** True for `claude_local` (Claude Code CLI adapter type). */
export function isClaudeCliAdapterType(adapterType: string): boolean {
  return adapterType === "claude_local";
}

export function isCursorCliAdapterType(adapterType: string): boolean {
  return adapterType === "cursor";
}

export function isCodebuddyCliAdapterType(adapterType: string): boolean {
  return adapterType === "codebuddy_local";
}

export function isQwenCliAdapterType(adapterType: string): boolean {
  return adapterType === "qwen_local";
}

/** Local + SSH sandbox/remotes: same adapter set as historically hard-coded. */
export function adapterSupportsRemoteCliExecution(adapterType: string): boolean {
  return (
    adapterType === "acpx_local" ||
    isCodexCliAdapterType(adapterType) ||
    isClaudeCliAdapterType(adapterType) ||
    adapterType === "codebuddy_local" ||
    adapterType === "gemini_local" ||
    adapterType === "opencode_local" ||
    adapterType === "pi_local" ||
    isCursorCliAdapterType(adapterType)
  );
}
