export type MobileWebHandoffTarget = "onboarding" | "agent_configuration" | "project_configuration";

export interface CreateMobileWebHandoffRequest {
  target: MobileWebHandoffTarget;
  companyId?: string;
  agentId?: string;
  projectId?: string;
}

export interface MobileWebHandoffResponse {
  url: string;
  expiresAt: string;
}
