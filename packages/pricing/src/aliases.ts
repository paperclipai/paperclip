/**
 * Provider/model alias resolution for the pricing catalog.
 *
 * The catalog is keyed by `${provider}/${model}` after normalization. Adapters in
 * the wild emit a small set of well-known shapes that don't directly hit the
 * canonical key — most notably AWS Bedrock model IDs of the form
 * `us.anthropic.claude-opus-4-6-v1` and curated mismatches from upstream model
 * registries.
 *
 * This module is a *normalization seam* — the only place that hard-codes the
 * mapping from "what adapters report" to "what the catalog stores." Adding a new
 * alias here is preferred over forking the catalog data.
 */

/**
 * Region prefixes used by AWS Bedrock model IDs (e.g. `us.anthropic.claude-...`).
 * Any model string that begins with one of these is considered a Bedrock-style
 * regional alias and gets folded onto the base entry.
 */
export const BEDROCK_REGION_PREFIXES = ["us.", "eu.", "apac.", "ap-"];

/**
 * Try to collapse a Bedrock-style raw key (`<provider>/<region>.anthropic.claude-opus-4-6-v1`)
 * onto the base catalog key (`anthropic/claude-opus-4-6`).
 *
 * Returns the resolved key, or null if the input does not match a Bedrock shape.
 *
 * Examples:
 *   resolveBedrockAlias("anthropic/us.anthropic.claude-opus-4-6-v1")
 *     → "anthropic/claude-opus-4-6"
 *   resolveBedrockAlias("anthropic/eu.anthropic.claude-sonnet-4-5-20250929-v1:0")
 *     → "anthropic/claude-sonnet-4-5-20250929"
 *   resolveBedrockAlias("anthropic/claude-opus-4-6")
 *     → null  (not Bedrock shape)
 *
 * Documented approximation: regional surcharges are ignored — `us.` and `eu.`
 * collapse to the same base catalog rate. See `doc/pricing.md` (Lane H).
 */
export function resolveBedrockAlias(rawKey: string): string | null {
  const slashIdx = rawKey.indexOf("/");
  if (slashIdx < 0) return null;

  const provider = rawKey.slice(0, slashIdx);
  const model = rawKey.slice(slashIdx + 1);

  // Detect a region prefix on the model portion (case-insensitive).
  const lowered = model.toLowerCase();
  const matchedPrefix = BEDROCK_REGION_PREFIXES.find((prefix) => lowered.startsWith(prefix));
  if (!matchedPrefix) return null;

  // Strip the region prefix.
  let stripped = model.slice(matchedPrefix.length);

  // Bedrock IDs look like `anthropic.claude-opus-4-6-v1` or
  // `anthropic.claude-sonnet-4-5-20250929-v1:0`. Convert the FIRST dot to a
  // separator and discard everything that follows the model name's `-v1[:N]`
  // suffix.
  const firstDot = stripped.indexOf(".");
  let bedrockProvider = provider;
  if (firstDot >= 0) {
    bedrockProvider = stripped.slice(0, firstDot);
    stripped = stripped.slice(firstDot + 1);
  }

  // Drop trailing `-v<digits>(:<digits>)?` versioning that Bedrock appends.
  stripped = stripped.replace(/-v\d+(?::\d+)?$/i, "");

  if (!stripped) return null;
  return `${bedrockProvider}/${stripped}`.toLowerCase();
}

/**
 * Curated alias map for keys that come out of adapters with a different shape
 * than the catalog uses. Keep this list small and well-commented — new entries
 * should be driven by real test failures (Lane F), not speculation.
 *
 * Both keys and values are lowercase, post-normalization.
 */
export const STATIC_ALIASES: Record<string, string> = {
  // Older models.dev / litellm sometimes surfaced `claude-3.5-sonnet` while the
  // canonical catalog key uses `claude-3-5-sonnet`. Cover the few that have
  // shipped in the wild.
  "anthropic/claude-3.5-sonnet": "anthropic/claude-3-5-sonnet-20241022",
  "anthropic/claude-3.5-haiku": "anthropic/claude-3-5-haiku-20241022",
};
