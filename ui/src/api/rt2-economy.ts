import { api } from "./client";

export type Rt2PnlSummary = {
  totalIncome: number;
  totalExpenses: number;
  netPnL: number;
  activeActors: number;
  topEarners: { actorId: string; actorType: string; income: number }[];
  approvedDeliverableRevenue: number;
  approvedDeliverableCount: number;
  ledgerEntryCount: number;
  calculationEvidence: {
    settlementStatus: "ready" | "partial" | "missing";
    period: string;
    approvedDeliverableCount: number;
    approvedDeliverableRevenue: number;
    ledgerEntryCount: number;
    ledgerByType: Record<string, number>;
    sourceTables: string[];
    warnings: string[];
  };
};

export type Rt2PnlRow = {
  id: string;
  companyId: string;
  actorId: string;
  actorType: "user" | "agent";
  period: string;
  income: number;
  expenses: number;
  netPnL: number;
  budgetAllocated: number;
  budgetUsed: number;
};

export type Rt2MarketplaceEvidence = {
  skills: string[];
  deliverableCount: number;
  approvedDeliverableCount: number;
  averageQualityScore: number | null;
  approvedBasePriceGold: number;
  earnedGoldEstimate: number;
  reputationIndex: number | null;
  collaborationMultiplier: number | null;
  subscriptionCount: number;
  evidenceStatus: "ready" | "partial" | "missing";
  calculationBasis: string[];
  latestApprovedDeliverables: Array<{
    workProductId: string;
    title: string;
    type: string;
    basePriceGold: number;
    qualityScore: number;
    earnedGold: number;
  }>;
  pricing: {
    pricingType: string;
    pricePerTaskCents: number | null;
    monthlySubscriptionCents: number | null;
  };
};

export type Rt2MarketplaceListing = {
  id: string;
  creatorCompanyId: string;
  name: string;
  description: string | null;
  category: string;
  tags: string[] | null;
  pricingType: string;
  pricePerTaskCents: number | null;
  monthlySubscriptionCents: number | null;
  capabilities: string;
  adapterType: string;
  isActive: boolean;
  totalSubscriptions: number;
  ratingAverage: number;
  ratingCount: number;
  evidence?: Rt2MarketplaceEvidence;
};

export type Rt2PnlDrilldown = Rt2PnlRow & {
  approvedDeliverables: Array<{
    workProductId: string;
    taskIssueId: string;
    projectId: string | null;
    title: string;
    type: string;
    ownerActorId: string;
    ownerActorType: "user" | "agent";
    revenue: number;
    qualityScore: number;
    qualityScoreId: string;
    approvalMode: string | null;
    approvedAt: string;
  }>;
  ledgerEntries: Array<{
    id: string;
    amount: number;
    balanceAfter: number;
    transactionType: "earned" | "spent" | "transferred" | "reward" | "penalty";
    description: string | null;
    referenceId: string | null;
    referenceType: string | null;
    period: string;
    createdAt: string;
  }>;
  revenueFromApprovedDeliverables: number;
};

export type Rt2SettlementFlow = {
  id: string;
  companyId: string;
  workProductId: string;
  taskIssueId: string;
  ownerActorId: string;
  ownerActorType: "user" | "agent";
  proposedPriceGold: number;
  finalPriceGold: number | null;
  rationale: string;
  negotiationComments: Array<{
    actorId: string;
    actorType: "user" | "agent" | "system";
    comment: string;
    createdAt: string;
  }>;
  status: "proposed" | "approval_required" | "approved" | "rejected";
  approvalRequired: boolean;
  approvalGateReason: string | null;
  riskLevel: "low" | "medium" | "high";
  antiGamingSignals: Array<{
    key: string;
    label: string;
    severity: "info" | "warning" | "critical";
    evidence: string;
    thresholdBasis?: string;
  }>;
  approverId: string | null;
  decisionReason: string | null;
  ledgerEntryId: string | null;
  ledgerEvidence: {
    id: string;
    amount: number;
    balanceAfter: number;
    transactionType: "earned" | "spent" | "transferred" | "reward" | "penalty";
    period: string;
    createdAt: string;
  } | null;
  pnlPeriod: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Rt2SettlementThresholdSettings = {
  highValueGold: number;
  selfReviewCriticalCount: number;
  goldFarmingEarnedCount: number;
  goldFarmingWarningGold: number;
  goldFarmingWarningMultiplier: number;
  goldFarmingCriticalGold: number;
  goldFarmingCriticalMultiplier: number;
  qualityBiasAutoScore: number;
  evaluationWindowDays: number;
};

export type Rt2SettlementOverview = {
  companyId: string;
  period: string;
  settlements: Rt2SettlementFlow[];
  summary: {
    total: number;
    proposed: number;
    approvalRequired: number;
    approved: number;
    rejected: number;
    highRisk: number;
  };
  thresholds: Rt2SettlementThresholdSettings;
};

export const rt2EconomyApi = {
  getPnlSummary: (companyId: string, period?: string) => {
    const qs = period ? `?period=${encodeURIComponent(period)}` : "";
    return api.get<Rt2PnlSummary>(`/companies/${companyId}/rt2/pnl/summary${qs}`);
  },
  listPnlRows: (companyId: string, period?: string) => {
    const qs = period ? `?period=${encodeURIComponent(period)}` : "";
    return api.get<Rt2PnlRow[]>(`/companies/${companyId}/rt2/pnl${qs}`);
  },
  getPnlDrilldown: (companyId: string, actorId: string, actorType: "user" | "agent", period?: string) => {
    const params = new URLSearchParams({ actorType });
    if (period) params.set("period", period);
    return api.get<Rt2PnlDrilldown>(
      `/companies/${companyId}/rt2/pnl/drilldown/${encodeURIComponent(actorId)}?${params.toString()}`,
    );
  },
  getSettlementOverview: (companyId: string, period?: string) => {
    const qs = period ? `?period=${encodeURIComponent(period)}` : "";
    return api.get<Rt2SettlementOverview>(`/companies/${companyId}/rt2/pnl/settlements${qs}`);
  },
  getSettlementThresholds: (companyId: string) =>
    api.get<Rt2SettlementThresholdSettings>(`/companies/${companyId}/rt2/pnl/settlements/thresholds`),
  updateSettlementThresholds: (companyId: string, input: Partial<Rt2SettlementThresholdSettings>) =>
    api.put<Rt2SettlementThresholdSettings>(`/companies/${companyId}/rt2/pnl/settlements/thresholds`, input),
  addSettlementComment: (companyId: string, settlementId: string, comment: string) =>
    api.post<Rt2SettlementFlow>(
      `/companies/${companyId}/rt2/pnl/settlements/${encodeURIComponent(settlementId)}/comment`,
      { comment },
    ),
  approveSettlement: (
    companyId: string,
    settlementId: string,
    input: { finalPriceGold?: number; decisionReason?: string },
  ) =>
    api.post<Rt2SettlementFlow>(
      `/companies/${companyId}/rt2/pnl/settlements/${encodeURIComponent(settlementId)}/approve`,
      input,
    ),
  rejectSettlement: (companyId: string, settlementId: string, decisionReason: string) =>
    api.post<Rt2SettlementFlow>(
      `/companies/${companyId}/rt2/pnl/settlements/${encodeURIComponent(settlementId)}/reject`,
      { decisionReason },
    ),
  listMarketplaceAgents: (companyId: string) =>
    api.get<Rt2MarketplaceListing[]>(`/companies/${companyId}/rt2/marketplace/agents`),
};
