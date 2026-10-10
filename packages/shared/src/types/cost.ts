import type { AgentAppearance } from "../agent-appearance.js";
import type { BillingType, CostStatus } from "../constants.js";

export interface CostEvent {
  subscriptionId?: string | null;
  usageKind?: "agent" | "decision" | "fast_response";
  responsibleUserId?: string | null;
  id: string;
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  heartbeatRunId: string | null;
  billingCode: string | null;
  idempotencyKey: string | null;
  provider: string;
  biller: string;
  billingType: BillingType;
  costStatus: CostStatus;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
  costCentsExact?: string;
  occurredAt: Date;
  createdAt: Date;
}

export interface CostSummary {
  eventCount: number;
  pendingRunCount: number;
  unpricedEventCount: number;
  estimatedEventCount?: number;
  pricingComplete: boolean;
  companyId: string;
  spendCents: number;
  spendCentsExact?: string;
  budgetCents: number;
  utilizationPercent: number;
}

export interface IssueCostSummary {
  issueId: string;
  issueCount: number;
  includeDescendants: boolean;
  costCents: number;
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** number of distinct heartbeat runs aggregated across the issue tree */
  runCount: number;
  /** sum of wall-clock duration of each run in the tree (ms);
   * still-running runs contribute (now - startedAt) so this ticks up live */
  runtimeMs: number;
}

export interface CostByUser {
  /** The run's recorded responsible user; null means unattributed. */
  userId: string | null;
  userName: string | null;
  userImage: string | null;
  eventCount: number;
  estimatedEventCount: number;
  unpricedEventCount: number;
  costCents: number;
  costCentsExact: string;
  /** Input excludes cached input, as in other cost reports. */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** Distinct recorded runs with cost events in the selected period. */
  runCount: number;
}

export interface CostByUserReport {
  /** Active human members, excluding the synthetic local-board principal. */
  activeUserCount: number;
  /** Includes zero-spend active users, even in single-user companies. */
  rows: CostByUser[];
}

export interface CostByAgent {
  agentId: string | null;
  agentName: string | null;
  agentAppearance?: AgentAppearance | null;
  avatarUrl?: string;
  agentStatus: string | null;
  /** Ledger events in this group and selected date range, not distinct runs. */
  eventCount: number;
  estimatedEventCount: number;
  costCents: number;
  costCentsExact?: string;
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
  costCentsExact?: string;
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
  costCentsExact?: string;
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
  agentId: string | null;
  agentName: string | null;
  agentAppearance?: AgentAppearance | null;
  avatarUrl?: string;
  provider: string;
  biller: string;
  billingType: BillingType;
  model: string;
  /** Ledger events in this group and selected date range, not distinct runs. */
  eventCount: number;
  estimatedEventCount: number;
  costCents: number;
  costCentsExact?: string;
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
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

/** cost attributed to a project via heartbeat run → activity log → issue → project chain */
export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  /** Ledger events in this project and selected date range, not distinct runs. */
  eventCount: number;
  estimatedEventCount: number;
  costCents: number;
  costCentsExact?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}
