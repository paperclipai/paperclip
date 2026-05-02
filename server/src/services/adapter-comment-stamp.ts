/**
 * Runtime-side adapter/model stamping for agent comments (SOP-914).
 *
 * Every UI-visible comment attributed to an agent gets a first-line stamp
 * derived from the agent's failover-chain config — NOT from model
 * self-knowledge. If the model emits its own stamp, it is replaced.
 */

const ADAPTER_STAMP_RE = /^\[Adapter: [^\]]+\s*\|\s*Model: [^\]]+\]\r?\n?/;

/**
 * Build the config-derived stamp line.
 */
export function buildAdapterStamp(adapterType: string, model: string | null | undefined): string {
  const modelName = typeof model === "string" && model.trim().length > 0 ? model.trim() : "default model";
  return `[Adapter: ${adapterType} | Model: ${modelName}]`;
}

/**
 * Strip any existing adapter/model stamp (model-supplied or stale) from the
 * first line, then prepend the config-derived stamp.
 *
 * Returns the modified body. Does NOT mutate the input.
 */
export function stampAdapterModel(body: string, adapterType: string, model: string | null | undefined): string {
  const stamp = buildAdapterStamp(adapterType, model);
  const stripped = body.replace(ADAPTER_STAMP_RE, "");
  return `${stamp}\n${stripped}`;
}

/**
 * Return true when the body already starts with an adapter stamp line.
 */
export function hasAdapterStamp(body: string): boolean {
  return ADAPTER_STAMP_RE.test(body);
}
