/**
 * Parsing + types for the `cost_event.created` payload.
 *
 * Field names are pinned to the host schema in
 * `packages/db/src/schema/cost_events.ts`. We read defensively because the
 * payload crosses the host→worker boundary as untyped JSON.
 */

export interface CostEvent {
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  heartbeatRunId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: string | null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asOptionalString(value: unknown): string | null {
  const s = asString(value).trim();
  return s.length > 0 ? s : null;
}

function asNonNegativeInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * Parse a `cost_event.created` payload into a typed CostEvent.
 *
 * Returns null when the payload lacks the fields the Clipper requires to act
 * (company, agent, and a usable cost). `companyId` may also arrive on the event
 * envelope rather than the payload, so the caller can pass a fallback.
 */
export function parseCostEvent(
  payload: unknown,
  envelopeCompanyId?: string,
): CostEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;

  const companyId = asOptionalString(p.companyId) ?? asOptionalString(envelopeCompanyId);
  const agentId = asOptionalString(p.agentId);
  if (!companyId || !agentId) return null;

  // costCents is the authoritative spend figure on the schema. Treat a missing
  // or non-numeric value as a parse failure rather than silently zero.
  const rawCost = p.costCents;
  const costNum = typeof rawCost === "number" ? rawCost : Number(rawCost);
  // A negative cost (e.g. a refund/correction) would skew the Welford baseline
  // if folded in as 0, so reject it the same way we reject non-numeric values.
  if (!Number.isFinite(costNum) || costNum < 0) return null;

  return {
    companyId,
    agentId,
    issueId: asOptionalString(p.issueId),
    projectId: asOptionalString(p.projectId),
    heartbeatRunId: asOptionalString(p.heartbeatRunId),
    provider: asString(p.provider) || "unknown",
    model: asString(p.model) || "unknown",
    inputTokens: asNonNegativeInt(p.inputTokens),
    cachedInputTokens: asNonNegativeInt(p.cachedInputTokens),
    outputTokens: asNonNegativeInt(p.outputTokens),
    costCents: Math.round(costNum),
    occurredAt: asOptionalString(p.occurredAt),
  };
}

/** A detected cost anomaly, recorded for the dashboard and metrics. */
export interface CostAnomaly {
  rule: "z_score" | "absolute_ceiling";
  companyId: string;
  agentId: string;
  issueId: string | null;
  provider: string;
  model: string;
  costCents: number;
  /** Rolling mean before this event (cents); null when no baseline yet. */
  meanCents: number | null;
  /** Standard deviations above the mean; null for the absolute rule cold-start. */
  zScore: number | null;
  occurredAt: string | null;
  detectedAt: string;
  /** Human-readable one-line explanation for the issue comment / dashboard. */
  reason: string;
}
