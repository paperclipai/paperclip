/**
 * Exact model-catalog for the Hermes adapter.
 *
 * Hermes Agent supports arbitrary models via arbitrary providers, so the
 * adapter does NOT ship a curated list of runnable models (see the `models`
 * export in index.ts which is intentionally `[]`).  Instead, this module
 * provides exact-catalog authentication: a set of model identifiers whose
 * legitimacy is verified by exact string match (never substring).
 *
 * The primary use case is proving the exact model in the current-result
 * footer that Hermes emits after each run.  When the adapter detects a
 * cataloged model identity in the footer, it can authenticate the result
 * with certainty — a substring match would accept an impostor like
 * `gemini-3.1-pro-preview-evil` or `not-gemini-3.1-pro-preview`.
 */

/** A model entry in the exact catalog. */
export interface ModelCatalogEntry {
  /** Canonical model identifier as used on the wire (e.g. gemini CLI). */
  id: string;
  /** Human-readable label, including any tier annotation. */
  label: string;
  /** Provider slug this model belongs to. */
  provider: string;
  /** Optional tier annotation (e.g. "high" for Gemini 3.1 Pro (High)). */
  tier?: string;
}

/**
 * Exact model catalog.
 *
 * Every entry's `id` is an exact string that must match character-for-character
 * when authenticating.  Substring, prefix, or suffix matching is never used.
 */
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: "gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    provider: "gemini",
    tier: "high",
  },
];

/**
 * Authenticate a model string against the exact catalog.
 *
 * Returns the matching catalog entry when `modelId` is an EXACT match
 * (case-sensitive, character-for-character) for a catalog entry's `id`.
 * Returns `null` when no exact entry matches.
 *
 * NEVER uses substring, prefix, or suffix matching.  An input like
 * `gemini-3.1-pro-preview-evil` will NOT match `gemini-3.1-pro-preview`.
 *
 * @param modelId The model string to authenticate.
 * @returns The matching catalog entry, or null if not found.
 */
export function authenticateModel(modelId: string): ModelCatalogEntry | null {
  if (typeof modelId !== "string" || modelId === "") return null;
  for (const entry of MODEL_CATALOG) {
    if (modelId === entry.id) return entry;
  }
  return null;
}

/**
 * Authenticate a model string and throw if it does not match any catalog entry.
 *
 * This is the strict gate: any mismatch (substring, suffix, typo, etc.)
 * produces a `ModelAuthFailure` error.
 *
 * @param modelId The model string to authenticate.
 * @throws {ModelAuthFailure} when the model is not an exact catalog match.
 */
export function requireAuthenticatedModel(modelId: string): ModelCatalogEntry {
  const entry = authenticateModel(modelId);
  if (entry === null) {
    throw new ModelAuthFailure(modelId);
  }
  return entry;
}

/**
 * Error thrown when a model string fails exact-catalog authentication.
 *
 * The `modelId` property preserves the exact input that was rejected,
 * so callers can build an informative diagnostic message.
 */
export class ModelAuthFailure extends Error {
  readonly modelId: string;

  constructor(modelId: string) {
    super(
      `Model "${modelId}" is not an exact entry in the Hermes model catalog. ` +
        `Substring, prefix, and suffix matching are disabled for security. ` +
        `Authenticating catalog entry "gemini-3.1-pro-preview" will fail ` +
        `if the input contains extra characters.`,
    );
    this.name = "ModelAuthFailure";
    this.modelId = modelId;
  }
}
