/**
 * Pure, deterministic cost-anomaly detection.
 *
 * No SDK or I/O dependencies so it can be unit-tested directly and reasoned
 * about by reviewers. The worker owns persistence; this module owns the math.
 *
 * Aggregates use Welford's online algorithm so we keep O(1) state per agent and
 * never retain the raw event history.
 */
import type { CostClipperConfig } from "./constants.js";
import type { CostAnomaly, CostEvent } from "./contracts.js";

/** Welford running stats for one agent's per-event cost (in cents). */
export interface AgentAggregate {
  agentId: string;
  /** Number of cost events seen. */
  count: number;
  /** Running mean of costCents. */
  mean: number;
  /** Sum of squared deviations (Welford M2); variance = m2 / (count - 1). */
  m2: number;
  /** Total cents spent — useful for "top spenders". */
  totalCents: number;
  /** Per-model spend breakdown (cents). */
  byModel: Record<string, number>;
  /** Per-provider spend breakdown (cents). */
  byProvider: Record<string, number>;
  lastOccurredAt: string | null;
}

export interface CompanyAggregates {
  /** keyed by agentId */
  agents: Record<string, AgentAggregate>;
}

export function emptyCompanyAggregates(): CompanyAggregates {
  return { agents: {} };
}

function emptyAgentAggregate(agentId: string): AgentAggregate {
  return {
    agentId,
    count: 0,
    mean: 0,
    m2: 0,
    totalCents: 0,
    byModel: {},
    byProvider: {},
    lastOccurredAt: null,
  };
}

/** Sample standard deviation; 0 when fewer than 2 samples. */
export function stddev(agg: AgentAggregate): number {
  if (agg.count < 2) return 0;
  const variance = agg.m2 / (agg.count - 1);
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/**
 * Evaluate a cost event against the agent's *prior* aggregate, returning an
 * anomaly if a rule trips. Detection reads the baseline as it stood BEFORE this
 * event so a spike is measured against history, not against itself.
 */
export function detect(
  prior: AgentAggregate | undefined,
  event: CostEvent,
  config: CostClipperConfig,
  detectedAt: string,
): CostAnomaly | null {
  // Rule 1 — absolute ceiling. Fires with no history, covering cold start.
  if (event.costCents >= config.absoluteCentsCeiling) {
    return {
      rule: "absolute_ceiling",
      companyId: event.companyId,
      agentId: event.agentId,
      issueId: event.issueId,
      provider: event.provider,
      model: event.model,
      costCents: event.costCents,
      meanCents: prior && prior.count > 0 ? round2(prior.mean) : null,
      zScore: zScoreOf(prior, event.costCents),
      occurredAt: event.occurredAt,
      detectedAt,
      reason:
        `$${dollars(event.costCents)} single-event cost on model "${event.model}" ` +
        `(${event.provider}) is at/above the $${dollars(config.absoluteCentsCeiling)} ceiling.`,
    };
  }

  // Rule 2 — z-score spike. Needs a baseline of at least minSamples events.
  if (prior && prior.count >= config.minSamples) {
    const sd = stddev(prior);
    if (sd > 0) {
      const z = (event.costCents - prior.mean) / sd;
      if (z >= config.zThreshold) {
        return {
          rule: "z_score",
          companyId: event.companyId,
          agentId: event.agentId,
          issueId: event.issueId,
          provider: event.provider,
          model: event.model,
          costCents: event.costCents,
          meanCents: round2(prior.mean),
          zScore: round2(z),
          occurredAt: event.occurredAt,
          detectedAt,
          reason:
            `$${dollars(event.costCents)} is ${round2(z)}σ above this agent's mean of ` +
            `$${dollars(prior.mean)} over ${prior.count} prior runs (model "${event.model}").`,
        };
      }
    }
  }

  return null;
}

/** Fold a cost event into the company aggregates, mutating and returning it. */
export function applyEvent(
  aggregates: CompanyAggregates,
  event: CostEvent,
): CompanyAggregates {
  const existing = aggregates.agents[event.agentId] ?? emptyAgentAggregate(event.agentId);

  // Welford update.
  const count = existing.count + 1;
  const delta = event.costCents - existing.mean;
  const mean = existing.mean + delta / count;
  const delta2 = event.costCents - mean;
  const m2 = existing.m2 + delta * delta2;

  const next: AgentAggregate = {
    agentId: event.agentId,
    count,
    mean,
    m2,
    totalCents: existing.totalCents + event.costCents,
    byModel: { ...existing.byModel, [event.model]: (existing.byModel[event.model] ?? 0) + event.costCents },
    byProvider: {
      ...existing.byProvider,
      [event.provider]: (existing.byProvider[event.provider] ?? 0) + event.costCents,
    },
    lastOccurredAt: event.occurredAt ?? existing.lastOccurredAt,
  };

  aggregates.agents[event.agentId] = next;
  return aggregates;
}

function zScoreOf(prior: AgentAggregate | undefined, costCents: number): number | null {
  if (!prior || prior.count < 2) return null;
  const sd = stddev(prior);
  if (sd <= 0) return null;
  return round2((costCents - prior.mean) / sd);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}
