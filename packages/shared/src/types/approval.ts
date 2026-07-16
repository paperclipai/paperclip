import type {
  AgentResponseAdapterConfig,
  AgentResponseDesiredSkill,
  AgentResponsePermissions,
  AgentResponseRuntimeConfig,
} from "./agent.js";
import type { ApprovalStatus, ApprovalType } from "../constants.js";

export interface Approval {
  id: string;
  companyId: string;
  type: ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface HireApprovalConfigurationResponse {
  name?: string;
  role?: string;
  title?: string;
  icon?: string;
  reportsTo?: string;
  capabilities?: string;
  adapterType?: string;
  defaultEnvironmentId?: string;
  budgetMonthlyCents?: number;
  adapterConfig?: AgentResponseAdapterConfig;
  runtimeConfig?: AgentResponseRuntimeConfig;
  permissions?: AgentResponsePermissions;
  desiredSkills?: AgentResponseDesiredSkill[];
}

export interface HireAgentApprovalResponsePayload extends HireApprovalConfigurationResponse {
  agentId?: string;
  requestedByAgentId?: string;
  sourceBuiltInAgentKey?: string;
  sourcePluginId?: string;
  sourcePluginKey?: string;
  managedResourceKey?: string;
  featureKeys?: string[];
  requestedConfigurationSnapshot?: HireApprovalConfigurationResponse;
}

export interface CeoStrategyApprovalResponsePayload {
  title?: string;
  summary?: string;
  plan?: string;
  description?: string;
  strategy?: string;
  text?: string;
  recommendedAction?: string;
  nextActionOnApproval?: string;
}

export interface BudgetOverrideApprovalResponsePayload {
  scopeType?: string;
  scopeId?: string;
  scopeName?: string;
  metric?: string;
  windowKind?: string;
  thresholdType?: string;
  windowStart?: string;
  windowEnd?: string;
  policyId?: string;
  guidance?: string;
  budgetAmount?: number;
  observedAmount?: number;
  warnPercent?: number;
}

export interface BoardApprovalResponsePayload {
  title?: string;
  summary?: string;
  recommendedAction?: string;
  nextActionOnApproval?: string;
  proposedComment?: string;
  source?: string;
  issueId?: string;
  taskId?: string;
  taskKey?: string;
  commentId?: string;
  invocationId?: string;
  actionRequestId?: string;
  tool?: string;
  risk?: string;
  argumentsHash?: string;
  risks?: string[];
}

export type ApprovalResponsePayload =
  | HireAgentApprovalResponsePayload
  | CeoStrategyApprovalResponsePayload
  | BudgetOverrideApprovalResponsePayload
  | BoardApprovalResponsePayload;

/** Public approval DTO with a type-specific, positively projected payload. */
export interface ApprovalResponse extends Omit<Approval, "payload"> {
  payload: ApprovalResponsePayload;
}

export interface ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}
