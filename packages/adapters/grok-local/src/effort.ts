const GROK_XHIGH_UNSUPPORTED_PREFIXES = ["grok-4.5"];
const GROK_XHIGH_SUPPORTED_PREFIXES = ["grok-4.6", "grok-build"];

function normalizeGrokModelId(model: string | null | undefined): string {
  const trimmed = (model ?? "").trim().toLowerCase();
  // Empty model uses the adapter default, which is grok-4.6.
  return trimmed || "grok-4.6";
}

/**
 * Map catalog/saved ids onto what the current Grok CLI accepts.
 * `grok-build` was the old host alias; Grok CLI 1.0.5 rejects it as an unknown model.
 */
export function resolveGrokCliModelId(model: string | null | undefined): string {
  const id = normalizeGrokModelId(model);
  if (id === "grok-build" || id.startsWith("grok-build-")) return "grok-4.6";
  return id;
}

/** grok-4.6 and grok-build advertise xhigh. grok-4.5 does not and rejects it. */
export function grokModelSupportsXhigh(model: string | null | undefined): boolean {
  const id = normalizeGrokModelId(model);
  if (GROK_XHIGH_UNSUPPORTED_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}-`))) {
    return false;
  }
  return GROK_XHIGH_SUPPORTED_PREFIXES.some((prefix) => id === prefix || id.startsWith(`${prefix}-`));
}

/** Drop or remap an effort the selected Grok model cannot run. */
export function resolveGrokReasoningEffort(
  model: string | null | undefined,
  effort: string | null | undefined,
): string {
  const trimmed = (effort ?? "").trim();
  if (!trimmed) return "";
  if (trimmed === "xhigh" && !grokModelSupportsXhigh(model)) return "high";
  return trimmed;
}
