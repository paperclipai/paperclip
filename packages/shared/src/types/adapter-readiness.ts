import type {
  ADAPTER_READINESS_REASON_CODES,
  ADAPTER_READINESS_STATUSES,
  LOCAL_ADAPTER_ASSURANCE_TYPES,
} from "../constants.js";

export type LocalAdapterAssuranceType = (typeof LOCAL_ADAPTER_ASSURANCE_TYPES)[number];
export type AdapterReadinessStatus = (typeof ADAPTER_READINESS_STATUSES)[number];
export type AdapterReadinessReasonCode = (typeof ADAPTER_READINESS_REASON_CODES)[number];

export interface AdapterReadinessBooleans {
  basicReady: boolean;
  operationalReady: boolean;
  fixtureReady: boolean;
}

export interface AdapterFallbackRecommendation {
  adapterType: LocalAdapterAssuranceType;
  label: string;
  reason: string;
  requiresApproval: true;
}

export interface AdapterReadinessProbe {
  id: string;
  companyId: string;
  agentId: string;
  adapterType: LocalAdapterAssuranceType;
  status: AdapterReadinessStatus;
  basicReady: boolean;
  operationalReady: boolean;
  fixtureReady: boolean;
  reasonCodes: AdapterReadinessReasonCode[];
  cliVersion: string | null;
  authMode: string | null;
  model: string | null;
  modelProfile: string | null;
  workspaceStatus: string | null;
  quotaWindows: Record<string, unknown> | null;
  helloRunStatus: string | null;
  helloRunMetadata: Record<string, unknown> | null;
  heartbeatRunId: string | null;
  fallbackRecommendation: AdapterFallbackRecommendation | null;
  strictMode: boolean;
  checkedByUserId: string | null;
  checkedAt: string;
  createdAt: string;
}
