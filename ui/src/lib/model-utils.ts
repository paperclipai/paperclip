export function extractProviderId(modelId: string): string | null {
  const trimmed = modelId.trim();
  if (!trimmed.includes("/")) return null;
  const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
  return provider || null;
}

export function extractProviderIdWithFallback(modelId: string, fallback = "other"): string {
  return extractProviderId(modelId) ?? fallback;
}

export function extractModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed.includes("/")) return trimmed;
  return trimmed.slice(trimmed.indexOf("/") + 1).trim();
}

/**
 * Built-in adapters whose model list arrives in a deliberate order: Claude and Codex by family
 * and version, the runner's Codex list, Gemini with `Auto` first, Grok, Kimi, OpenClaw, and the
 * OpenCode and Pi lists, which the server sorts when discovered and which lead with the default
 * model when it falls back to the declared list. The model dropdown shows these lists as the
 * adapter advertises them. Cursor is left out because its list comes from `agent models`
 * discovery, whose order can change between refreshes. Adapters not named here, including
 * externally installed ones, keep the dropdown's alphabetical order.
 */
const CURATED_MODEL_ORDER_ADAPTERS: ReadonlySet<string> = new Set([
  "claude_local",
  "codex_local",
  "paperclip_runner",
  "gemini_local",
  "grok_local",
  "kimi_local",
  "openclaw_gateway",
  "opencode_local",
  "pi_local",
  "agy_local",
]);

export function adapterCuratesModelOrder(adapterType: string): boolean {
  return CURATED_MODEL_ORDER_ADAPTERS.has(adapterType);
}
