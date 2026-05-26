import type {
  MODEL_ASSURANCE_MODEL_SOURCES,
  MODEL_ASSURANCE_POLICY_STATUSES,
  MODEL_ASSURANCE_REASON_CODES,
  MODEL_ASSURANCE_ROLE_FITS,
} from "../constants.js";

export type ModelAssuranceModelSource = (typeof MODEL_ASSURANCE_MODEL_SOURCES)[number];
export type ModelAssurancePolicyStatus = (typeof MODEL_ASSURANCE_POLICY_STATUSES)[number];
export type ModelAssuranceRoleFit = (typeof MODEL_ASSURANCE_ROLE_FITS)[number];
export type ModelAssuranceReasonCode = (typeof MODEL_ASSURANCE_REASON_CODES)[number];

export interface ModelAssuranceSummary {
  selectedModel: string | null;
  resolvedModel: string | null;
  modelSource: ModelAssuranceModelSource;
  modelProfile: string | null;
  modelAvailable: boolean;
  modelRunnable: boolean;
  policyStatus: ModelAssurancePolicyStatus;
  roleFit: ModelAssuranceRoleFit;
  roleFitReason: string | null;
  reasonCodes: ModelAssuranceReasonCode[];
  capabilities: Record<string, unknown> | null;
}
