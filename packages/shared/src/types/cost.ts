import type { BillingType, CostStatus } from "../constants.js";

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  costStatus: CostStatus;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  companyId: string;
  spendCents: number;
  budgetCents: number;
  utilizationPercent: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** cents actually billed through a metered api — the only spend that hits a card */
  meteredCostCents: number;
  /**
   * dollar value of subscription usage. `spendCents` stays 0 for it by design
   * (the plan already paid), so this is the only figure that shows the account
   * burning through its quota before a lockout.
   */
  subscriptionCostUsd: number;
  eventCount: number;
  runCount: number;
  /** runs whose cost event carries no price — usage known, dollars unknown */
  unpricedRunCount: number;
  /** runs that produced no cost event at all */
  unmeteredRunCount: number;
  strandedRunCount: number;
  strandedTokens: number;
  neverRanRunCount: number;
  lostRunCount: number;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** number of distinct heartbeat runs aggregated across the issue tree */
  runCount: number;
  /** sum of wall-clock duration of each run in the tree (ms);
   * still-running runs contribute (now - startedAt) so this ticks up live */
  runtimeMs: number;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProviderModel {
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByBiller {
  biller: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionCachedInputTokens: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
  providerCount: number;
  modelCount: number;
}

/** per-agent breakdown by provider + model, for identifying token-hungry agents */
export interface CostByAgentModel {
  agentId: string;
  agentName: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** spend per provider for a fixed rolling time window */
export interface CostWindowSpendRow {
  provider: string;
  biller: string;
  /** duration label, e.g. "5h", "24h", "7d" */
  window: string;
  /** rolling window duration in hours */
  windowHours: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/**
 * tokens and cost attributed to a single task, ranked by token volume.
 *
 * one row per run: a run belongs to exactly one issue, the one resolved into
 * `cost_events.issue_id` at finalization. Summing each issue's `/runs` instead
 * inflates the company total by ~87%, because that route hands the full run —
 * usage included — to every issue the run merely touched.
 *
 * runs with no owning issue are omitted here and reported by `summary`, so the
 * remainder stays visible instead of being folded into some task.
 */
export interface CostByIssue {
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  issueStatus: string | null;
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  meteredCostCents: number;
  subscriptionCostUsd: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  runCount: number;
  unpricedRunCount: number;
}

/**
 * tokens and cost per routine, rolled up across every firing.
 *
 * each firing opens its own issue, so a daily routine's cost is otherwise
 * scattered across dozens of unrelated-looking tasks. Costs are counted through
 * the linked issue's whole subtree, because work a firing delegates to a child
 * is still that routine's cost.
 */
export interface CostByRoutine {
  routineId: string;
  routineTitle: string | null;
  routineStatus: string | null;
  assigneeAgentId: string | null;
  assigneeAgentName: string | null;
  /** issues reachable from this routine's firings, subtree included */
  issueCount: number;
  runCount: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  subscriptionCostUsd: number;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
