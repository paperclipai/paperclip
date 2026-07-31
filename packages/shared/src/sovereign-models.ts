/**
 * Sovereign model validation utilities.
 *
 * A "sovereign" model is one that runs on infrastructure controlled by the
 * operator (self-hosted LLM gateway, on-premise hardware, etc.) rather than
 * routing through a third-party cloud API.
 *
 * The current check is convention-based: a model is considered sovereign if
 * its id or label contains one of the {@link SOVEREIGN_MODEL_MARKERS}.
 * Adapters are expected to label their models accordingly (e.g. prefix
 * "Sovereign " to all models served through a sovereign gateway).
 */

/** Markers whose presence (case-insensitive) in a model id/label signals sovereignty. */
const SOVEREIGN_MODEL_MARKERS = ["sovereign", "souverain"] as const;

/**
 * Returns `true` if the raw string value represents a sovereign model.
 * Checks whether the trimmed, lowercased value contains any of the
 * {@link SOVEREIGN_MODEL_MARKERS}.
 */
export function isSovereignAgentModelValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return SOVEREIGN_MODEL_MARKERS.some((marker) => normalized.includes(marker));
}

/** Minimal shape for model objects that carry an id and optional label. */
export interface AgentModelLike {
  id: string;
  label?: string | null;
}

/**
 * Returns `true` if a model object is sovereign — i.e. its `id` or `label`
 * passes {@link isSovereignAgentModelValue}.
 */
export function isSovereignAgentModel(model: AgentModelLike): boolean {
  return isSovereignAgentModelValue(model.id) || isSovereignAgentModelValue(model.label ?? "");
}

/**
 * Filters a list of models to only those that are sovereign.
 */
export function filterSovereignAgentModels<T extends AgentModelLike>(models: T[]): T[] {
  return models.filter(isSovereignAgentModel);
}
