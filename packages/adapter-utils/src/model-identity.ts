/**
 * The value recorded on a cost event when the model a run used could not be
 * determined. Callers should prefer a real model id; this exists so the ledger
 * distinguishes "not attributed" from a plausible-looking wrong answer.
 */
export const UNKNOWN_MODEL_ID = "unknown";

/**
 * Model ids that identify a *selection policy* rather than a model. Agent model
 * pickers advertise these (ACP's `default`, "auto" routing modes), and an
 * adapter that echoes one back would put a string into the cost ledger that
 * looks like a model but cannot be priced, compared, or audited — which is
 * strictly worse than recording nothing, because it hides the gap.
 */
const PLACEHOLDER_MODEL_IDS = new Set(["default", "auto", "none", "unknown"]);

/** True when the id names a selection policy instead of a model. */
export function isPlaceholderModelId(model: string | null | undefined): boolean {
  if (typeof model !== "string") return true;
  const trimmed = model.trim();
  return !trimmed || PLACEHOLDER_MODEL_IDS.has(trimmed.toLowerCase());
}

/**
 * Normalize an adapter-reported model id for the cost ledger.
 *
 * Every adapter result reaching the ledger goes through here so no adapter —
 * present or future — can record a picker placeholder as a model. A run whose
 * model cannot be identified is recorded as `unknown`, which the model-attribution
 * audit can find and act on; a run recorded as `default` would be invisible.
 */
export function normalizeRecordedModelId(model: string | null | undefined): string {
  return isPlaceholderModelId(model) ? UNKNOWN_MODEL_ID : (model as string).trim();
}
