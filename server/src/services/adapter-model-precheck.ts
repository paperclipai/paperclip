/**
 * Configuration-time guard against the failure class that burned 12 identical
 * runs: an `adapterConfig.model` the provider rejects with a permanent HTTP 400.
 * The adapter already classifies that rejection as permanent at run time so the
 * agent fails once instead of re-incarnating; this moves the same error earlier,
 * to the moment an operator saves the config, where it costs zero tokens.
 *
 * The guard is deliberately narrow. A custom OpenAI-compatible gateway serves
 * model ids that the server cannot enumerate (the discovery call goes to the
 * upstream provider, not to the gateway), so a strict allowlist would reject
 * *working* configurations. When a gateway is configured the check stands down
 * and run-time classification remains the only backstop.
 */

/**
 * Env keys that redirect an adapter at a custom OpenAI-compatible endpoint.
 * Presence of any of these means the served model ids are not enumerable from
 * here, so the model id cannot be checked against a discovered list.
 */
const GATEWAY_ENV_KEYS: readonly string[] = [
  "PAPERCLIP_CODEX_PROVIDERS",
  "PAPERCLIP_OPENCODE_PROVIDERS",
  "PAPERCLIP_PI_PROVIDERS",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
];

export type AdapterModelPrecheckOutcome =
  | { kind: "ok" }
  | { kind: "skipped"; reason: string }
  | { kind: "unknown_model"; model: string; knownModels: string[] };

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when the adapterConfig points the adapter at an endpoint whose model
 * catalog we cannot enumerate. Also treats a `model_provider` selector inside
 * an otherwise-plain config as a gateway signal.
 */
export function usesUnenumerableModelSource(
  adapterConfig: Record<string, unknown>,
): string | null {
  if (asNonEmptyString(adapterConfig.baseUrl)) return "adapterConfig.baseUrl";
  if (asNonEmptyString(adapterConfig.modelProvider)) return "adapterConfig.modelProvider";
  const env = adapterConfig.env;
  if (!isPlainObject(env)) return null;
  for (const key of GATEWAY_ENV_KEYS) {
    if (asNonEmptyString(env[key])) return `adapterConfig.env.${key}`;
  }
  return null;
}

/**
 * Decide whether a model id should be rejected at configuration time.
 *
 * `knownModels` is the list the model picker itself offers (the same source as
 * `GET /api/companies/{companyId}/adapters/{type}/models`). An empty list means
 * discovery failed or is unavailable — that is not evidence the model is wrong,
 * so the check stands down rather than blocking a save on a transient outage.
 *
 * Matching is exact on the trimmed id, mirroring how the id is handed to the
 * provider. Case is significant because provider model ids are case-sensitive.
 */
export function precheckAdapterModel(input: {
  adapterConfig: Record<string, unknown>;
  knownModels: readonly { id: string }[];
}): AdapterModelPrecheckOutcome {
  const model = asNonEmptyString(input.adapterConfig.model);
  // No model set means the adapter default applies, which is by construction a
  // model the adapter supports.
  if (!model) return { kind: "skipped", reason: "no model configured" };

  const gatewaySource = usesUnenumerableModelSource(input.adapterConfig);
  if (gatewaySource) {
    return {
      kind: "skipped",
      reason: `${gatewaySource} points at a custom endpoint whose model catalog is not enumerable`,
    };
  }

  const knownIds = input.knownModels
    .map((entry) => asNonEmptyString(entry?.id))
    .filter((id): id is string => id !== null);
  if (knownIds.length === 0) {
    return { kind: "skipped", reason: "model discovery returned no models" };
  }
  if (knownIds.includes(model)) return { kind: "ok" };

  return { kind: "unknown_model", model, knownModels: knownIds };
}

/**
 * Operator-facing message for a rejected model. Names the offending field, the
 * offending value, and the route that lists valid ids — the same three facts the
 * run-time blocked-issue notice carries, so the two paths read identically.
 */
export function describeUnknownModel(input: {
  adapterType: string;
  model: string;
  knownModels: readonly string[];
  companyId?: string | null;
  suggestionLimit?: number;
}): string {
  const limit = input.suggestionLimit ?? 8;
  const sample = input.knownModels.slice(0, limit);
  const remainder = input.knownModels.length - sample.length;
  const companySegment = input.companyId ?? "{companyId}";
  const suffix = remainder > 0 ? `, and ${remainder} more` : "";
  return (
    `adapterConfig.model "${input.model}" is not offered for adapter "${input.adapterType}". `
    + `The provider rejects an unknown model id permanently, so an agent configured this way `
    + `fails on every run without making progress. `
    + `Valid ids come from GET /api/companies/${companySegment}/adapters/${input.adapterType}/models `
    + `(currently: ${sample.join(", ")}${suffix}).`
  );
}
