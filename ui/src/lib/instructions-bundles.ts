const INSTRUCTIONS_BUNDLE_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "hermes_local",
  "cursor",
]);

export function supportsInstructionsBundles(adapterType: string) {
  return INSTRUCTIONS_BUNDLE_ADAPTER_TYPES.has(adapterType);
}
