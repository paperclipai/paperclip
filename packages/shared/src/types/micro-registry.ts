export interface MicroRegistryPod {
  id: string;
  companyId: string;
  paperclipIssueId: string | null;
  identifier: string;
  title: string;
  source: string;
  thesis: string;
  ownerAgentId: string | null;
  lifecycleState: string;
  improvementAttemptCount: number;
  dependencies: unknown[];
  computeAssignmentId?: string | null;
  dataAssignmentId?: string | null;
  brokerAssignmentId?: string | null;
  evidencePackId?: string | null;
  promotionRequestId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface MicroRegistryExperiment {
  id: string;
  companyId: string;
  podId: string;
  paperclipIssueId: string | null;
  identifier: string;
  title: string;
  hypothesis: string;
  sourceKind: string;
  sourceUrl: string | null;
  lifecycleState: string;
  maxImprovementAttempts: number;
  improvementAttemptCount: number;
  overnightAllowed: boolean;
  holdingPeriodMinMinutes: number;
  holdingPeriodMaxMinutes: number | null;
  metrics: Record<string, unknown>;
  verdict: string | null;
  verdictReason: string | null;
  evidencePackId: string | null;
  promotionRequestId: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface MicroRegistryDependencyRequest {
  id: string;
  companyId: string;
  podId: string | null;
  experimentId: string | null;
  kind: string;
  title: string;
  description: string | null;
  status: string;
  routedToAgentId: string | null;
  paperclipIssueId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface MicroRegistryEvidencePack {
  id: string;
  companyId: string;
  podId: string | null;
  experimentId: string | null;
  title: string;
  status: string;
  artifactUri: string;
  summary: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface MicroRegistryPromotionRequest {
  id: string;
  companyId: string;
  podId: string | null;
  experimentId: string | null;
  evidencePackId: string | null;
  target: string;
  status: string;
  rationale: string;
  riskNotes: string | null;
  paperclipIssueId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface MicroRegistryOverview {
  pods: MicroRegistryPod[];
  experiments: MicroRegistryExperiment[];
  dependencyRequests: MicroRegistryDependencyRequest[];
  evidencePacks: MicroRegistryEvidencePack[];
  promotionRequests: MicroRegistryPromotionRequest[];
}
