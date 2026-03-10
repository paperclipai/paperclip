import type { PricingState } from "../constants.js";

export interface CostEvent {
  id: string;
  companyId: string;
  agentId: string;
  issueId: string | null;
  projectId: string | null;
  goalId: string | null;
  billingCode: string | null;
  provider: string;
  model: string;
  inputTokens: number;
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
  pricingState: PricingState;
}

export interface CostByAgent {
  agentId: string;
  agentName: string | null;
  agentStatus: string | null;
  costCents: number;
  pricingState: PricingState;
  inputTokens: number;
  outputTokens: number;
  apiRunCount: number;
  subscriptionRunCount: number;
  subscriptionInputTokens: number;
  subscriptionOutputTokens: number;
}

export interface CostByProject {
  projectId: string | null;
  projectName: string | null;
  costCents: number;
  pricingState: PricingState;
  inputTokens: number;
  outputTokens: number;
}
